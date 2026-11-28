"""Phase 6: pipeline orchestrator + health tracking.

Runs the EXISTING Phase 1-5 batches in dependency order, with job locking,
failure isolation, checkpointing (delegated to each scan) and a health record.
It ORCHESTRATES only — it never changes any Phase 1-5 rule or the weekly engine.

Run (locally or from CI):
    python -m intel.orchestrate --mode daily     # regime -> recommend -> news
    python -m intel.orchestrate --mode weekly     # + data refresh + optimisation
    python -m intel.orchestrate --mode full        # everything
    python -m intel.orchestrate --only news        # a single job (same safety)

Design:
  * Each step runs as an isolated subprocess (one job's crash cannot kill the
    pipeline). Exit code + duration + output tail are recorded per job.
  * Atomic writes in every scan mean a FAILED job never publishes partial data as
    complete: downstream jobs read the previous COMPLETE upstream output, never a
    half-written one. A job marked FAILED in health did not publish a success.
  * A lock file prevents overlapping runs (belt-and-suspenders with CI
    concurrency). Stale locks (> MAX_LOCK_AGE) are reclaimed (safe recovery).
  * Idempotent: re-running produces updated-or-identical data; append-only
    histories dedup; resumable scans skip completed work.
"""
import argparse
import datetime as _dt
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from intel.store import JsonFileStore  # noqa: E402

MAX_LOCK_AGE = 3 * 3600   # seconds; a lock older than this is considered stale

# job id -> (module, args, depends_on). Dependencies are documentary + enforced
# by only reading COMPLETE committed upstream outputs (atomic writes guarantee it).
JOBS = {
    "data":      ("intel.scan_universe", [], []),
    "regime":    ("intel.scan_regime", ["--fresh"], ["data"]),
    "optimize":  ("intel.scan_optimize", ["--fresh"], ["data"]),
    "recommend": ("intel.scan_recommend", ["--fresh"], ["regime", "optimize"]),
    "news":      ("intel.scan_news", ["--fresh"], []),
    "outcomes":  ("intel.scan_outcomes", [], []),
}
MODES = {
    # daily: keep recommendations fresh; reuse the weekly optimisation (do NOT
    # re-optimise every day — Phase 3 results change slowly).
    "daily": ["regime", "recommend", "news", "outcomes"],
    # weekly: full refresh incl. data coverage + optimisation.
    "weekly": ["data", "optimize", "regime", "recommend", "news", "outcomes"],
    "full": ["data", "regime", "optimize", "recommend", "news", "outcomes"],
}


def _now():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _lock_path(store):
    return os.path.join(store.root, ".pipeline.lock")


def acquire_lock(store):
    p = _lock_path(store)
    now = time.time()
    try:
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                info = json.load(f)
            age = now - info.get("ts", 0)
            if age < MAX_LOCK_AGE:
                return False, info  # a fresh run holds the lock -> refuse overlap
            # stale -> reclaim (safe recovery after an interrupted run)
        os.makedirs(store.root, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "ts": now, "started_at": _now()}, f)
        return True, None
    except Exception as e:  # noqa: BLE001
        return False, {"error": str(e)}


def release_lock(store):
    try:
        os.remove(_lock_path(store))
    except OSError:
        pass


def _freshness(store):
    """Report each committed output's generated_at + age in hours."""
    out = {}
    files = {"universe": "get_universe", "regime": "get_regime", "optimize": "get_optimize",
             "recommend": "get_recommend", "news": "get_news"}
    for name, getter in files.items():
        try:
            d = getattr(store, getter)()
            gen = (d or {}).get("generated_at")
        except Exception:  # noqa: BLE001
            gen = None
        age_h = None
        if gen:
            try:
                age_h = round((_dt.datetime.now(_dt.timezone.utc)
                               - _dt.datetime.fromisoformat(gen)).total_seconds() / 3600, 1)
            except Exception:  # noqa: BLE001
                age_h = None
        out[name] = {"generated_at": gen, "age_hours": age_h}
    return out


def run_job(job):
    mod, args, _deps = JOBS[job]
    t0 = time.time()
    started = _now()
    try:
        proc = subprocess.run([sys.executable, "-m", mod] + args,
                              cwd=ROOT, capture_output=True, text=True, timeout=3600)
        ok = proc.returncode == 0
        tail = (proc.stdout or "")[-400:] + (("\nSTDERR:" + proc.stderr[-400:]) if proc.stderr and not ok else "")
        err = None if ok else "exit %d" % proc.returncode
    except subprocess.TimeoutExpired:
        ok, tail, err = False, "", "timeout (>3600s)"
    except Exception as e:  # noqa: BLE001 — failure isolation
        ok, tail, err = False, "", str(e)[:200]
    return {"job": job, "status": "SUCCESS" if ok else "FAILED",
            "started_at": started, "finished_at": _now(),
            "duration_s": round(time.time() - t0, 1),
            "error": err, "output_tail": tail.strip()[-500:]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=list(MODES), default="daily")
    ap.add_argument("--only", choices=list(JOBS), default=None)
    args = ap.parse_args()
    jobs = [args.only] if args.only else MODES[args.mode]

    store = JsonFileStore()
    got, holder = acquire_lock(store)
    if not got:
        print("Another pipeline run holds the lock; refusing to overlap:", holder)
        # record the refusal in health without overwriting the last good run
        h = store.get_health() or {}
        h["last_refused_at"] = _now()
        store.put_health(h)
        return 2

    run_id = _now()
    results = []
    print("Pipeline run %s  mode=%s  jobs=%s" % (run_id, args.mode, jobs))
    try:
        for job in jobs:
            # Upstream guard: if a dependency ran in THIS run and did not succeed,
            # do not compute on its now-stale output (it would be stamped fresh).
            bad_up = [d for d in JOBS[job][2]
                      if any(x["job"] == d and x["status"] != "SUCCESS" for x in results)]
            if bad_up:
                print("--> %s SKIPPED (upstream failed this run: %s)" % (job, ", ".join(bad_up)))
                results.append({"job": job, "status": "SKIPPED", "started_at": _now(),
                                "finished_at": _now(), "duration_s": 0.0,
                                "error": "upstream failed this run: " + ", ".join(bad_up),
                                "output_tail": ""})
                continue
            print("--> %s ..." % job)
            r = run_job(job)
            results.append(r)
            print("    %s in %.0fs%s" % (r["status"], r["duration_s"], "" if r["status"] == "SUCCESS" else " (" + str(r["error"]) + ")"))
            # failure isolation: independent jobs still run; dependents are guarded above
    finally:
        _write_health(store, run_id, args.mode, results)
        release_lock(store)

    failed = [r["job"] for r in results if r["status"] != "SUCCESS"]
    print("\nDone. success=%d failed=%s" % (sum(1 for r in results if r["status"] == "SUCCESS"), failed or "none"))
    return 1 if failed else 0


def _write_health(store, run_id, mode, results):
    prev = store.get_health() or {"jobs": {}, "history": []}
    jobs = prev.get("jobs", {})
    for r in results:
        j = jobs.get(r["job"], {"success_count": 0, "fail_count": 0})
        j["last_run"] = r["finished_at"]
        j["last_status"] = r["status"]
        j["last_duration_s"] = r["duration_s"]
        j["last_error"] = r["error"]
        j["output_tail"] = r["output_tail"]
        if r["status"] == "SUCCESS":
            j["success_count"] = j.get("success_count", 0) + 1
            j["last_success"] = r["finished_at"]
        else:
            j["fail_count"] = j.get("fail_count", 0) + 1
        jobs[r["job"]] = j
    hist = (prev.get("history", []) + [{"run_id": run_id, "mode": mode, "finished_at": _now(),
            "results": [{"job": r["job"], "status": r["status"], "duration_s": r["duration_s"]} for r in results]}])[-30:]
    overall = "OK" if all(r["status"] == "SUCCESS" for r in results) else (
        "DEGRADED" if any(r["status"] == "SUCCESS" for r in results) else "FAILED")
    store.put_health({
        "generated_at": _now(), "methodology_version": "monitor-v1.0",
        "last_run_id": run_id, "last_mode": mode, "overall": overall,
        "jobs": jobs, "freshness": _freshness(store),
        "schedule": {"daily_utc": "12:30 Mon-Fri", "weekly_utc": "04:00 Sun",
                     "timezone_note": "cron is UTC; 12:30 UTC = 18:00 IST (after NSE close 15:30 IST)"},
        "infra": {"scheduler": "GitHub Actions", "cost": "free tier (~2000 Linux min/month)",
                  "paid_services": "none"},
        "history": hist,
    })


if __name__ == "__main__":
    sys.exit(main())
