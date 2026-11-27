"""Phase 1: storage abstraction (requirement — JSON now, DB later, no rewrite).

`Store` is the interface the engines use. `JsonFileStore` writes JSON under a
data/ directory with ATOMIC writes (temp file + os.replace) so a crash or a
failed scan never corrupts or overwrites the last-good file (fail-closed, 2.6).
A future DbStore implements the same methods — engines stay unchanged.

Storage limits (documented, enforced by the scanner's guardrail):
  working-tree data/ : soft 10 MB / hard 20 MB
  generated files    : soft 300 / hard 600
  rec-history        : 200 entries/stock then rotate to an archive
Overwriting a JSON file does NOT shrink git history — commit generated data on
the (infrequent) optimisation cadence and migrate to DbStore past the triggers.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
# data/ lives at the repo root (one level up from intel/). Resolve defensively
# so it works locally and in the bundled serverless function.
_CANDIDATES = [
    os.path.join(os.path.dirname(HERE), "data"),
    os.path.join(HERE, "data"),
    os.path.join(os.getcwd(), "data"),
    "data",
]


def _data_root():
    for p in _CANDIDATES:
        if os.path.isdir(p):
            return p
    return _CANDIDATES[0]


class Store:
    """Interface. Reads return None when absent; writes are atomic."""
    def get_universe(self): raise NotImplementedError
    def put_universe(self, data): raise NotImplementedError
    def get_stock(self, symbol): raise NotImplementedError
    def put_stock(self, symbol, data): raise NotImplementedError
    def get_scan_state(self): raise NotImplementedError
    def put_scan_state(self, data): raise NotImplementedError
    def append_run(self, entry): raise NotImplementedError


class JsonFileStore(Store):
    def __init__(self, root=None):
        self.root = root or _data_root()
        self.stock_dir = os.path.join(self.root, "stock")

    # ---- helpers ----
    def _read(self, path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001 — absent/corrupt reads as None
            return None

    def _atomic_write(self, path, obj):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"))
        os.replace(tmp, path)  # atomic on same filesystem

    # ---- universe (summary registry) ----
    def get_universe(self):
        return self._read(os.path.join(self.root, "universe.json"))

    def put_universe(self, data):
        self._atomic_write(os.path.join(self.root, "universe.json"), data)

    # ---- per-stock data-quality record ----
    def get_stock(self, symbol):
        return self._read(os.path.join(self.stock_dir, symbol.upper().replace("/", "_") + ".json"))

    def put_stock(self, symbol, data):
        self._atomic_write(os.path.join(self.stock_dir, symbol.upper().replace("/", "_") + ".json"), data)

    # ---- resumable scan state ----
    def get_scan_state(self):
        return self._read(os.path.join(self.root, "scan_state.json"))

    def put_scan_state(self, data):
        self._atomic_write(os.path.join(self.root, "scan_state.json"), data)

    # ---- append-only run log (audit) ----
    def append_run(self, entry):
        path = os.path.join(self.root, "scan_runs.jsonl")
        os.makedirs(self.root, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")

    # ---- storage-limit guardrail (bytes, file count) ----
    def usage(self):
        total = files = 0
        for base, _dirs, names in os.walk(self.root):
            for nm in names:
                try:
                    total += os.path.getsize(os.path.join(base, nm)); files += 1
                except OSError:
                    pass
        return {"bytes": total, "files": files,
                "soft_bytes": 10 * 1024 * 1024, "hard_bytes": 20 * 1024 * 1024,
                "soft_files": 300, "hard_files": 600,
                "over_soft": total > 10 * 1024 * 1024 or files > 300}
