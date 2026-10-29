"""Stratospheric polar vortex diagnostics at 10 hPa for each forecast step.

* u60      - zonal-mean zonal wind at 60 deg (the standard sudden stratospheric
             warming metric: a reversal to easterly < 0 m/s is a major SSW).
* tcap     - area-weighted polar-cap (60-90 deg) temperature.
* edge     - vortex edge as the 10 hPa geopotential height contour with the
             strongest mean wind speed along it (seasonally adaptive, after the
             Nash et al. 1996 maximum-gradient idea applied to geopotential).
* centroid, aspect ratio, area and number of pieces describe the vortex shape
  (displacement vs split events, cf. Waugh 1997 / Seviour et al. 2013).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy import ndimage

EARTH_R_KM = 6371.0


def load_field(step_dir: Path, name: str, meta: dict) -> np.ndarray | None:
    p = step_dir / f"{name}.bin"
    if not p.exists():
        return None
    m = meta[name]
    raw = np.fromfile(p, dtype="<u2" if m["dtype"] == "u2" else "u1").astype(np.float64)
    top = 65535.0 if m["dtype"] == "u2" else 255.0
    return (m["min"] + raw / top * (m["max"] - m["min"])).reshape(m["ny"], m["nx"])


def components(mask: np.ndarray) -> np.ndarray:
    """Connected-component labels with periodic longitude and a single pole point."""
    labels, n = ndimage.label(mask)
    if n == 0:
        return labels
    parent = list(range(n + 1))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        if a and b:
            parent[find(a)] = find(b)

    for row in range(labels.shape[0]):
        union(labels[row, 0], labels[row, -1])
    pole_labels = [l for l in np.unique(labels[0]) if l]
    for l in pole_labels[1:]:
        union(l, pole_labels[0])
    flat = np.array([find(i) for i in range(n + 1)])
    return flat[labels]


def hemisphere_stats(z, u, v, t, lat, lon, hemi: str) -> dict:
    sign = 1 if hemi == "nh" else -1
    hlat = lat * sign  # poleward-positive latitude
    cosw = np.cos(np.radians(lat))[:, None] * np.ones_like(z)

    row60 = int(np.argmin(np.abs(lat - 60 * sign)))
    u60 = float(u[row60].mean())

    cap = hlat >= 60
    tcap = float((t[cap] * cosw[cap]).sum() / cosw[cap].sum())

    # Work in poleward-positive orientation so the pole is row 0.
    rows = np.where(hlat >= 35)[0]
    if hemi == "sh":
        rows = rows[::-1]
    zz, ww = z[rows], cosw[rows]
    spd = np.hypot(u[rows], v[rows])
    llat, cos_r = lat[rows], np.cos(np.radians(lat[rows]))

    lo, hi = np.percentile(zz, [1, 99])
    bins = np.linspace(lo, hi, 81)
    which = np.digitize(zz, bins) - 1
    best_edge, best_speed = float(np.median(zz)), -1.0
    for b in range(80):
        sel = which == b
        if sel.sum() < 40:
            continue
        s = float((spd[sel] * ww[sel]).sum() / ww[sel].sum())
        if s > best_speed:
            best_speed, best_edge = s, float(0.5 * (bins[b] + bins[b + 1]))

    mask = zz < best_edge
    cell_km2 = (EARTH_R_KM ** 2) * np.radians(0.5) ** 2 * cos_r[:, None] * np.ones_like(zz)
    cell_km2[np.abs(llat) >= 89.99] = (EARTH_R_KM ** 2) * np.pi * np.radians(0.25) ** 2 / zz.shape[1]
    area = float(cell_km2[mask].sum())

    lat2d = np.radians(llat[:, None] * np.ones_like(zz))
    lon2d = np.radians(np.broadcast_to(lon, zz.shape))

    def centroid_of(sel):
        # Depth-weighted mean position on the sphere.
        w = (best_edge - zz[sel]) * cell_km2[sel]
        la, lo_ = lat2d[sel], lon2d[sel]
        c = (np.stack([np.cos(la) * np.cos(lo_), np.cos(la) * np.sin(lo_), np.sin(la)], 1) * w[:, None]).sum(0)
        c /= np.linalg.norm(c)
        return [round(float(np.degrees(np.arcsin(c[2]))), 2), round(float(np.degrees(np.arctan2(c[1], c[0]))), 2)]

    labels = components(mask)
    piece_centroids = []
    if area > 0:
        for l in np.unique(labels[labels > 0]):
            sel = labels == l
            if cell_km2[sel].sum() >= max(0.12 * area, 1.0e6):
                piece_centroids.append(centroid_of(sel))
    pieces = len(piece_centroids)

    centroid = None
    aspect = None
    if mask.sum() > 0:
        centroid = centroid_of(mask)
        la, lo_ = lat2d[mask], lon2d[mask]
        # Moments in a polar stereographic plane give the ellipse aspect ratio.
        r = 2 * np.tan((np.pi / 2 - la * sign) / 2)
        px, py = r * np.cos(lo_), r * np.sin(lo_)
        wa = cell_km2[mask]
        mx, my = np.average(px, weights=wa), np.average(py, weights=wa)
        cov = np.cov(np.stack([px - mx, py - my]), aweights=wa)
        ev = np.sort(np.linalg.eigvalsh(cov))
        if ev[0] > 0:
            aspect = float(np.sqrt(ev[1] / ev[0]))

    if u60 < 0:
        state = "reversed"
    elif pieces >= 2:
        state = "split"
    elif centroid is not None and abs(centroid[0]) < 66:
        state = "displaced"
    elif u60 >= 35:
        state = "strong"
    elif u60 >= 15:
        state = "moderate"
    else:
        state = "weak"

    return {"u60": round(u60, 2), "tcap": round(tcap, 2), "edge": round(best_edge, 1),
            "edgeSpeed": round(best_speed, 1), "areaMkm2": round(area / 1e6, 2),
            "centroid": centroid, "pieceCentroids": piece_centroids,
            "aspect": round(aspect, 2) if aspect else None, "pieces": pieces, "state": state}


def analyse_run(run_dir: Path) -> dict:
    manifest = json.loads((run_dir / "manifest.json").read_text())
    meta = manifest["fields"]
    ny, nx = meta["z10"]["ny"], meta["z10"]["nx"]
    lat = 90 - np.arange(ny) * 0.5
    lon = np.arange(nx) * 0.5
    out = {"run": manifest["run"], "level": "10 hPa", "nh": [], "sh": []}
    for step in manifest["steps"]:
        sd = run_dir / f"f{step['fh']:03d}"
        z, u, v, t = (load_field(sd, n, meta) for n in ("z10", "u10", "v10", "t10"))
        if any(x is None for x in (z, u, v, t)):
            continue
        for hemi in ("nh", "sh"):
            s = hemisphere_stats(z, u, v, t, lat, lon, hemi)
            s.update(fh=step["fh"], valid=step["valid"])
            out[hemi].append(s)
    (run_dir / "vortex.json").write_text(json.dumps(out))
    return out
