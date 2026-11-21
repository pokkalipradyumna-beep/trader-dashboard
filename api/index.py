"""Vercel serverless entry point for the API.

Vercel's Python runtime serves a module-level `handler` (a BaseHTTPRequestHandler
subclass). We reuse the *exact same* request handler as the local server, so the
API behaves identically whether it runs locally (server.py) or on Vercel.

`vercel.json` rewrites every /api/* request to this function; the handler routes
internally on the request path. The static frontend is served by Vercel from
`public/`, so this function only ever handles /api/* and /healthz.
"""
import os
import sys

# The backend modules (server/engine/quality/valuation/holdings) live at the repo
# root, one level above this api/ folder — add it to the import path.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server import Handler as handler  # noqa: E402,F401  (Vercel uses this)
