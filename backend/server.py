"""Local web server: serves the globe, the decoded GFS data, and a small API.
Keeps itself current by checking NOAA for a newer GFS run every 15 minutes.

    python -m backend.server [--port 8765] [--no-update]
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import socket
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

from . import ecmwf, gfs

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
CHECK_INTERVAL_S = 15 * 60
POINT_FIELDS = ("t2m", "prate", "csnow", "tcc", "prmsl", "u10m", "v10m")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/octet-stream", ".bin")


def point_series(lat: float, lon: float, model: str = "gfs") -> dict:
    src = ecmwf if model == "ecmwf" else gfs
    run = src.local_latest()
    if run is None:
        return {"error": "no data yet"}
    run_dir = src.RUNS_DIR / run
    manifest = json.loads((run_dir / "manifest.json").read_text())
    meta = manifest["fields"]
    series = {"run": run, "lat": lat, "lon": lon, "valid": [], **{f: [] for f in POINT_FIELDS}}
    for step in manifest["steps"]:
        series["valid"].append(step["valid"])
        for f in POINT_FIELDS:
            m = meta[f]
            p = run_dir / f"f{step['fh']:03d}" / f"{f}.bin"
            if not p.exists():
                series[f].append(None)
                continue
            row = int(round((90 - lat) / m["res"]))
            col = int(round((lon % 360) / m["res"])) % m["nx"]
            dtype = np.dtype("<u2" if m["dtype"] == "u2" else "u1")
            with open(p, "rb") as fh:
                fh.seek((row * m["nx"] + col) * dtype.itemsize)
                raw = np.frombuffer(fh.read(dtype.itemsize), dtype=dtype)[0]
            top = 65535.0 if m["dtype"] == "u2" else 255.0
            series[f].append(round(m["min"] + float(raw) / top * (m["max"] - m["min"]), 5))
    return series


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/api/status":
                return self.send_json({**gfs.get_status(), "latest": gfs.local_latest(),
                                       "ecmwf": {**ecmwf.get_status(), "latest": ecmwf.local_latest()}})
            if url.path == "/api/point":
                q = parse_qs(url.query)
                return self.send_json(point_series(float(q["lat"][0]), float(q["lon"][0]),
                                                   q.get("model", ["gfs"])[0]))
            if url.path.startswith("/data/"):
                return self.serve_data(url.path[len("/data/"):])
        except Exception as e:  # keep the server alive; report the error to the page
            traceback.print_exc()
            return self.send_json({"error": str(e)}, 500)
        return super().do_GET()

    def serve_data(self, rel: str):
        path = (gfs.DATA_DIR / rel).resolve()
        if gfs.DATA_DIR.resolve() not in path.parents or not path.is_file():
            return self.send_error(404)
        body = path.read_bytes()
        self.send_response(200)
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", ctype)
        # Field grids never change once written; manifests and summaries do.
        immutable = path.suffix == ".bin"
        self.send_header("Cache-Control", "public, max-age=604800, immutable" if immutable else "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def updater_loop():
    while True:
        # Each model updates independently so a failure in one never blocks the other.
        for src in (gfs, ecmwf):
            try:
                src.update_if_needed()
            except Exception as e:
                traceback.print_exc()
                src.set_status(state="error", message=f"Update failed: {e}")
        time.sleep(CHECK_INTERVAL_S)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-update", action="store_true", help="serve existing data only")
    args = ap.parse_args()
    gfs.RUNS_DIR.mkdir(parents=True, exist_ok=True)
    if not args.no_update:
        threading.Thread(target=updater_loop, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    # Also listen on IPv6 loopback: Windows resolves "localhost" to ::1 first and
    # otherwise waits ~2 s per request before falling back to IPv4.
    try:
        server6 = IPv6Server(("::1", args.port), Handler)
        threading.Thread(target=server6.serve_forever, daemon=True).start()
    except OSError:
        pass
    print(f"Weather Globe running at http://localhost:{args.port}")
    server.serve_forever()


class IPv6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


if __name__ == "__main__":
    main()
