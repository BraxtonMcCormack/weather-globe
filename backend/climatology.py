"""Build a 1991-2020 daily climatology of the 10 hPa polar vortex diagnostics
from NCEP/NCAR Reanalysis 1 (NOAA PSL OPeNDAP), matching vortex.py:

* u60  - zonal-mean zonal wind at 60N / 60S, 10 hPa
* tcap - area-weighted polar-cap (60-90) temperature, 10 hPa

For each calendar day a +/-7 day window across 30 years (~450 samples) gives
mean, std and percentiles. Output: web/assets/vortex_climatology.json

    python -m backend.climatology        (one-off; ~10 minutes, rate-limited)
"""
from __future__ import annotations

import datetime as dt
import json
import struct
import time
from pathlib import Path

import numpy as np
import requests

BASE = "https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/pressure"
YEARS = range(1991, 2021)
LEVEL_10HPA = 16          # index into the 17 standard levels
LAT_N60, LAT_S60 = 12, 60  # 2.5 deg grid from 90N
OUT = Path(__file__).resolve().parent.parent / "web" / "assets" / "vortex_climatology.json"
PCTS = [0, 5, 10, 25, 50, 75, 90, 95, 100]

session = requests.Session()
session.headers["User-Agent"] = "weather-globe/1.0 (personal climatology build)"


def fetch_array(var: str, year: int, lat_slice: str, ndays: int) -> np.ndarray:
    """Fetch var[day][10hPa][lats][lon] as a float array via the DODS binary (XDR) format."""
    url = f"{BASE}/{var}.{year}.nc.dods?{var}.{var}[0:1:{ndays - 1}][{LEVEL_10HPA}][{lat_slice}][0:1:143]"
    for attempt in range(8):
        r = session.get(url, timeout=120)
        if r.status_code == 200:
            body = r.content
            start = body.index(b"\nData:\n") + len(b"\nData:\n")
            n = struct.unpack(">I", body[start:start + 4])[0]
            vals = np.frombuffer(body[start + 8:start + 8 + 4 * n], dtype=">f4").astype(np.float64)
            return vals.reshape(ndays, -1, 144)
        time.sleep(5 * (attempt + 1))  # 429 rate limit: back off
    raise RuntimeError(f"failed: {url}")


def main():
    lats = 90 - 2.5 * np.arange(73)
    w_n = np.cos(np.radians(lats[0:13]))
    w_s = np.cos(np.radians(lats[60:73]))
    # Samples per calendar day (index into a leap year).
    by_doy = {key: [[] for _ in range(366)] for key in ("u60n", "u60s", "tcapn", "tcaps")}

    for year in YEARS:
        ndays = 366 if year % 4 == 0 else 365
        series = {
            "u60n": fetch_array("uwnd", year, f"{LAT_N60}:1:{LAT_N60}", ndays)[:, 0].mean(axis=1),
            "u60s": fetch_array("uwnd", year, f"{LAT_S60}:1:{LAT_S60}", ndays)[:, 0].mean(axis=1),
        }
        time.sleep(3)
        tn = fetch_array("air", year, "0:1:12", ndays).mean(axis=2)
        time.sleep(3)
        ts = fetch_array("air", year, "60:1:72", ndays).mean(axis=2)
        series["tcapn"] = (tn * w_n).sum(1) / w_n.sum()
        series["tcaps"] = (ts * w_s).sum(1) / w_s.sum()
        for d in range(ndays):
            date = dt.date(year, 1, 1) + dt.timedelta(days=d)
            idx = dt.date(2000, date.month, date.day).timetuple().tm_yday - 1  # leap-year calendar
            for key, arr in series.items():
                by_doy[key][idx].append(float(arr[d]))
        print(year, "done", flush=True)
        time.sleep(3)

    out = {"source": "NCEP/NCAR Reanalysis 1 (NOAA PSL), 1991-2020, +/-7 day window",
           "level": "10 hPa", "percentiles": PCTS, "days": 366}
    for key, days in by_doy.items():
        stats = []
        for i in range(366):
            pool = []
            for off in range(-7, 8):
                pool.extend(days[(i + off) % 366])
            a = np.array(pool)
            stats.append({"mean": round(float(a.mean()), 2), "std": round(float(a.std()), 2),
                          "p": [round(float(x), 2) for x in np.percentile(a, PCTS)]})
        out[key] = stats
    OUT.write_text(json.dumps(out))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
