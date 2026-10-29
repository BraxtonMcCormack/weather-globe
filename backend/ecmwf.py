"""Download ECMWF IFS 0.25 degree open-data forecasts (CC-BY-4.0) into the same
on-disk format as GFS, so the browser can show either model or their difference.

Only the 00Z and 12Z cycles run out to 15 days (360 h), so those are used.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import requests

from . import gfs

HOSTS = [
    "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",  # AWS mirror, no rate limit
    "https://data.ecmwf.int/forecasts",
]
DATA_DIR = gfs.DATA_DIR / "ecmwf"
RUNS_DIR = DATA_DIR / "runs"
KEEP_RUNS = 2
FORECAST_HOURS = list(range(0, 361, 6))  # 15 days
MODEL_NAME = "ECMWF IFS 0.25°"

# Our field name -> (param, levtype, level). Units match the GFS fields except where converted below.
PARAMS = {
    "t2m": ("2t", "sfc", None),
    "prate": ("tprate", "sfc", None),
    "csnow": ("ptype", "sfc", None),
    "tcc": ("tcc", "sfc", None),
    "prmsl": ("msl", "sfc", None),
    "u10m": ("10u", "sfc", None),
    "v10m": ("10v", "sfc", None),
    "u250": ("u", "pl", "250"),
    "v250": ("v", "pl", "250"),
    "z500": ("gh", "pl", "500"),
    "z50": ("gh", "pl", "50"),
    "z10": ("gh", "pl", "10"),
    "t10": ("t", "pl", "10"),
    "u10": ("u", "pl", "10"),
    "v10": ("v", "pl", "10"),
}

session = requests.Session()
session.headers["User-Agent"] = "weather-globe/1.0 (personal visualisation)"

status_lock = threading.Lock()
status: dict = {"state": "idle", "run": None, "done": 0, "total": 0, "message": ""}


def set_status(**kw):
    with status_lock:
        status.update(kw)


def get_status() -> dict:
    with status_lock:
        return dict(status)


def file_base(host: str, cycle: dt.datetime, fh: int) -> str:
    d, h = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    return f"{host}/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-{fh}h-oper-fc"


def fetch(path_fn, suffix: str, headers=None, retries=4) -> bytes:
    """Try each host in turn, with retries."""
    last = None
    for attempt in range(retries):
        for host in HOSTS:
            try:
                r = session.get(path_fn(host) + suffix, headers=headers, timeout=60)
                if r.status_code in (200, 206):
                    return r.content
                last = f"HTTP {r.status_code}"
            except requests.RequestException as e:
                last = str(e)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"ECMWF fetch failed ({last})")


def latest_complete_cycle(now: dt.datetime | None = None) -> dt.datetime | None:
    now = now or dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    cycle = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 12)
    for _ in range(6):
        for host in HOSTS:
            try:
                if session.head(file_base(host, cycle, FORECAST_HOURS[-1]) + ".index", timeout=15).status_code == 200:
                    return cycle
            except requests.RequestException:
                pass
        cycle -= dt.timedelta(hours=12)
    return None


def convert(name: str, vals: np.ndarray) -> np.ndarray:
    if name == "tcc":
        return vals * 100.0                     # fraction -> %
    if name == "csnow":
        return np.isin(vals, (5, 6)).astype(np.float64)  # ptype snow / wet snow -> flag
    return vals


def process_step(cycle: dt.datetime, fh: int, out_dir: Path) -> dict:
    path_fn = lambda host: file_base(host, cycle, fh)
    rows = [json.loads(l) for l in fetch(path_fn, ".index").decode().splitlines() if l.strip()]
    step_dir = out_dir / f"f{fh:03d}"
    step_dir.mkdir(parents=True, exist_ok=True)
    written = {}
    for name, (param, levtype, level) in PARAMS.items():
        m = next((r for r in rows if r["param"] == param and r["levtype"] == levtype
                  and (level is None or r.get("levelist") == level)), None)
        if m is None:
            continue
        rng = f"bytes={m['_offset']}-{m['_offset'] + m['_length'] - 1}"
        vals = gfs.decode_grib(fetch(path_fn, ".grib2", headers={"Range": rng}))
        vals = np.roll(vals, gfs.NX // 2, axis=1)  # columns start at 180E; GFS layout starts at 0E
        _var, _lev, stride, dtype, lo, hi, _u = gfs.FIELDS[name]
        gfs.quantise(convert(name, vals)[::stride, ::stride], dtype, lo, hi).tofile(step_dir / f"{name}.bin")
        written[name] = True
    return written


def set_latest(run: str):
    tmp = DATA_DIR / "latest.json.tmp"
    tmp.write_text(json.dumps({"run": run}))
    os.replace(tmp, DATA_DIR / "latest.json")


def local_latest() -> str | None:
    p = DATA_DIR / "latest.json"
    return json.loads(p.read_text())["run"] if p.exists() else None


def prune_runs():
    runs = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir())
    for old in runs[:-KEEP_RUNS]:
        shutil.rmtree(old, ignore_errors=True)


def download_run(cycle: dt.datetime, workers: int = 6) -> str:
    from . import vortex

    rid = gfs.run_id(cycle)
    out_dir = RUNS_DIR / rid
    out_dir.mkdir(parents=True, exist_ok=True)
    # Resume: keep steps an earlier (possibly shorter) download already finished.
    steps: dict[int, dict] = {}
    manifest = out_dir / "manifest.json"
    if manifest.exists():
        for s in json.loads(manifest.read_text())["steps"]:
            if s["fh"] in FORECAST_HOURS and s["fields"]:
                steps[s["fh"]] = {f: True for f in s["fields"]}
    todo = [fh for fh in FORECAST_HOURS if fh not in steps]
    set_status(state="downloading", run=rid, done=len(steps), total=len(FORECAST_HOURS),
               message=f"Downloading ECMWF {rid}")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process_step, cycle, fh, out_dir): fh for fh in todo}
        for fut in as_completed(futures):
            steps[futures[fut]] = fut.result()
            set_status(done=len(steps))
    gfs.write_manifest(cycle, out_dir, steps, complete=True, model=MODEL_NAME)
    set_status(state="analysing", message="Analysing ECMWF polar vortex")
    vortex.analyse_run(out_dir)
    set_latest(rid)
    prune_runs()
    set_status(state="idle", message=f"Up to date: ECMWF {rid}")
    return rid


def update_if_needed() -> str | None:
    set_status(state="checking", message="Checking ECMWF for a newer run")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    cycle = latest_complete_cycle()
    if cycle is None:
        set_status(state="idle", message="Could not reach ECMWF; will retry")
        return None
    rid = gfs.run_id(cycle)
    manifest = RUNS_DIR / rid / "manifest.json"
    have = json.loads(manifest.read_text())["steps"] if manifest.exists() else []
    if (RUNS_DIR / rid / "vortex.json").exists() and have and have[-1]["fh"] >= FORECAST_HOURS[-1]:
        if local_latest() != rid:
            set_latest(rid)
        set_status(state="idle", run=rid, message=f"Up to date: ECMWF {rid}")
        return rid
    return download_run(cycle)
