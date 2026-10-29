"""Download and decode NOAA GFS 0.25 degree forecasts from the NOAA Open Data
(AWS S3) bucket, using .idx byte ranges so only the fields we need are fetched.

Each field is written as a little-endian uint16 (or uint8) grid with a fixed
linear quantisation range, so the browser can decode exact physical values.
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
import eccodes

BASE_URL = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RUNS_DIR = DATA_DIR / "runs"
KEEP_RUNS = 2

# Forecast hours to fetch: 6-hourly out to 16 days.
FORECAST_HOURS = list(range(0, 385, 6))

# GFS 0.25 grid: 721 rows (90N -> 90S), 1440 cols (0E -> 359.75E).
NY, NX = 721, 1440

# name: GRIB var, GRIB level, stride (1 = 0.25 deg, 2 = 0.5 deg), dtype, min, max, units
FIELDS = {
    "t2m":    ("TMP",   "2 m above ground",     1, "u2", 180.0, 340.0, "K"),
    "prate":  ("PRATE", "surface",              1, "u2", 0.0, 0.03, "kg m-2 s-1"),
    "csnow":  ("CSNOW", "surface",              1, "u1", 0.0, 1.0, "flag"),
    "tcc":    ("TCDC",  "entire atmosphere",    2, "u1", 0.0, 100.0, "%"),
    "prmsl":  ("PRMSL", "mean sea level",       2, "u2", 85000.0, 110000.0, "Pa"),
    "u10m":   ("UGRD",  "10 m above ground",    2, "u2", -100.0, 100.0, "m s-1"),
    "v10m":   ("VGRD",  "10 m above ground",    2, "u2", -100.0, 100.0, "m s-1"),
    "u250":   ("UGRD",  "250 mb",               2, "u2", -150.0, 150.0, "m s-1"),
    "v250":   ("VGRD",  "250 mb",               2, "u2", -150.0, 150.0, "m s-1"),
    "z500":   ("HGT",   "500 mb",               2, "u2", 4400.0, 6200.0, "gpm"),
    "z50":    ("HGT",   "50 mb",                2, "u2", 17000.0, 22500.0, "gpm"),
    "z10":    ("HGT",   "10 mb",                2, "u2", 25000.0, 34000.0, "gpm"),
    "t10":    ("TMP",   "10 mb",                2, "u2", 160.0, 280.0, "K"),
    "u10":    ("UGRD",  "10 mb",                2, "u2", -200.0, 200.0, "m s-1"),
    "v10":    ("VGRD",  "10 mb",                2, "u2", -200.0, 200.0, "m s-1"),
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


def run_id(cycle: dt.datetime) -> str:
    return cycle.strftime("%Y%m%d%H")


def file_url(cycle: dt.datetime, fh: int) -> str:
    d, h = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    return f"{BASE_URL}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.0p25.f{fh:03d}"


def latest_complete_cycle(now: dt.datetime | None = None) -> dt.datetime | None:
    """Newest cycle whose final forecast hour has been published."""
    now = now or dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    cycle = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 6)
    last = FORECAST_HOURS[-1]
    for _ in range(12):
        try:
            r = session.head(file_url(cycle, last) + ".idx", timeout=15)
            if r.status_code == 200:
                return cycle
        except requests.RequestException:
            pass
        cycle -= dt.timedelta(hours=6)
    return None


def parse_idx(text: str) -> list[tuple[int, str, str, int]]:
    """Return (byte offset, var, level, end offset) per GRIB message."""
    rows = []
    for line in text.strip().splitlines():
        parts = line.split(":")
        rows.append((int(parts[1]), parts[3], parts[4], parts[5]))
    out = []
    for i, (off, var, lev, _desc) in enumerate(rows):
        end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
        out.append((off, var, lev, end))
    return out


def fetch(url: str, headers=None, retries=4) -> bytes:
    for attempt in range(retries):
        try:
            r = session.get(url, headers=headers, timeout=60)
            if r.status_code in (200, 206):
                return r.content
            if r.status_code == 404:
                raise FileNotFoundError(url)
        except requests.RequestException:
            pass
        time.sleep(2 ** attempt)
    raise RuntimeError(f"failed to fetch {url}")


# ecCodes' definition parser is not thread-safe: concurrent first-time decodes can
# abort the whole process ("fatal flex scanner internal error"). Downloads stay
# parallel; only the (fast) decode is serialised.
_eccodes_lock = threading.Lock()


def decode_grib(buf: bytes) -> np.ndarray:
    with _eccodes_lock:
        gid = eccodes.codes_new_from_message(buf)
        try:
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            vals = eccodes.codes_get_values(gid).reshape(nj, ni)
            if eccodes.codes_get(gid, "jScansPositively"):
                vals = vals[::-1]
        finally:
            eccodes.codes_release(gid)
    assert vals.shape == (NY, NX), vals.shape
    return vals


def quantise(vals: np.ndarray, dtype: str, lo: float, hi: float) -> np.ndarray:
    top = 65535 if dtype == "u2" else 255
    q = np.round((np.clip(vals, lo, hi) - lo) / (hi - lo) * top)
    return q.astype("<u2" if dtype == "u2" else "u1")


def process_step(cycle: dt.datetime, fh: int, out_dir: Path) -> dict:
    """Fetch every field for one forecast hour; returns {field: True} for those written."""
    url = file_url(cycle, fh)
    idx = parse_idx(fetch(url + ".idx").decode())
    step_dir = out_dir / f"f{fh:03d}"
    step_dir.mkdir(parents=True, exist_ok=True)
    written = {}
    for name, (var, lev, stride, dtype, lo, hi, _u) in FIELDS.items():
        # First match is the instantaneous value when both inst. and averaged exist.
        match = next((m for m in idx if m[1] == var and m[2] == lev), None)
        if match is None:
            continue
        off, _, _, end = match
        rng = f"bytes={off}-{end}" if end is not None else f"bytes={off}-"
        vals = decode_grib(fetch(url, headers={"Range": rng}))
        vals = vals[::stride, ::stride]
        quantise(vals, dtype, lo, hi).tofile(step_dir / f"{name}.bin")
        written[name] = True
    return written


def field_meta() -> dict:
    meta = {}
    for name, (var, lev, stride, dtype, lo, hi, units) in FIELDS.items():
        ny = (NY - 1) // stride + 1
        nx = NX // stride
        meta[name] = {"var": var, "level": lev, "nx": nx, "ny": ny, "dtype": dtype,
                      "min": lo, "max": hi, "units": units, "res": 0.25 * stride}
    return meta


def write_manifest(cycle: dt.datetime, out_dir: Path, steps: dict, complete: bool,
                   model: str = "NOAA GFS 0.25°"):
    manifest = {
        "model": model,
        "run": run_id(cycle),
        "runTime": cycle.strftime("%Y-%m-%dT%H:%MZ"),
        "complete": complete,
        "fields": field_meta(),
        "steps": [
            {"fh": fh,
             "valid": (cycle + dt.timedelta(hours=fh)).strftime("%Y-%m-%dT%H:%MZ"),
             "fields": sorted(steps[fh].keys())}
            for fh in sorted(steps)
        ],
    }
    tmp = out_dir / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest))
    os.replace(tmp, out_dir / "manifest.json")


def set_latest(run: str):
    tmp = DATA_DIR / "latest.json.tmp"
    tmp.write_text(json.dumps({"run": run}))
    os.replace(tmp, DATA_DIR / "latest.json")


def local_latest() -> str | None:
    p = DATA_DIR / "latest.json"
    if p.exists():
        return json.loads(p.read_text())["run"]
    return None


def prune_runs():
    runs = sorted(p for p in RUNS_DIR.iterdir() if p.is_dir())
    for old in runs[:-KEEP_RUNS]:
        shutil.rmtree(old, ignore_errors=True)


def download_run(cycle: dt.datetime, workers: int = 6, on_step=None):
    from . import vortex  # local import avoids a cycle at module load

    rid = run_id(cycle)
    out_dir = RUNS_DIR / rid
    out_dir.mkdir(parents=True, exist_ok=True)
    steps: dict[int, dict] = {}
    total = len(FORECAST_HOURS)
    set_status(state="downloading", run=rid, done=0, total=total,
               message=f"Downloading GFS {rid}")
    first_publish_done = local_latest() is not None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process_step, cycle, fh, out_dir): fh for fh in FORECAST_HOURS}
        for fut in as_completed(futures):
            fh = futures[fut]
            steps[fh] = fut.result()
            set_status(done=len(steps))
            # Publish contiguous steps progressively so the first ever run is viewable early.
            contiguous = {}
            for h in FORECAST_HOURS:
                if h not in steps:
                    break
                contiguous[h] = steps[h]
            write_manifest(cycle, out_dir, contiguous, complete=False)
            if not first_publish_done and len(contiguous) >= 2:
                set_latest(rid)
                first_publish_done = True
            if on_step:
                on_step(fh)

    write_manifest(cycle, out_dir, steps, complete=True)
    set_status(state="analysing", message="Analysing polar vortex")
    vortex.analyse_run(out_dir)
    set_latest(rid)
    prune_runs()
    set_status(state="idle", message=f"Up to date: GFS {rid}")
    return rid


def update_if_needed() -> str | None:
    """Download the newest complete GFS run if we do not already have it."""
    set_status(state="checking", message="Checking NOAA for a newer GFS run")
    cycle = latest_complete_cycle()
    if cycle is None:
        set_status(state="idle", message="Could not reach NOAA; will retry")
        return None
    rid = run_id(cycle)
    manifest = RUNS_DIR / rid / "manifest.json"
    if manifest.exists() and json.loads(manifest.read_text()).get("complete") \
            and (RUNS_DIR / rid / "vortex.json").exists():
        if local_latest() != rid:
            set_latest(rid)
        set_status(state="idle", run=rid, message=f"Up to date: GFS {rid}")
        return rid
    return download_run(cycle)
