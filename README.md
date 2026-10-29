# Weather Globe

An interactive 3-D globe of the latest NOAA GFS forecast (0.25°, 16 days), with a
stratospheric polar vortex analysis.

**Run it:** double-click `start.bat`, or

```
.venv\Scripts\python -m backend.server
```

then open http://localhost:8765.

## Staying current

On start-up, and then every 15 minutes, the server checks for newer runs of both models
and downloads any complete run you don't have yet. The page switches to new runs without
a reload and keeps you at the same valid time. Only the two newest runs of each model are
kept.

| Model | Runs used | Range | Download | Source |
|---|---|---|---|---|
| NOAA GFS 0.25° | 00/06/12/18Z | 16 days, 6-hourly | ~40 s, ~700 MB | NOAA Open Data on AWS (`noaa-gfs-bdp-pds`) |
| ECMWF IFS 0.25° | 00/12Z | 10 days, 6-hourly | ~45 s, ~450 MB | ECMWF Open Data (CC-BY-4.0), AWS mirror |

Both models are fetched with byte-range requests, so only the needed fields are pulled.

## Model comparison

Use the **GFS / ECMWF / Diff** switch at the top of the layer panel.

- **ECMWF** shows the same layers from ECMWF's IFS model, matched to the GFS timeline by
  valid time. Past day 10 it shows a notice instead, because ECMWF's open data stops there.
- **Diff** shows GFS minus ECMWF. Red means GFS is higher, blue means ECMWF is higher, and
  clear means the two agree. Where they disagree, the forecast is less certain. Hovering
  shows both values and the difference.
- The point forecast overlays ECMWF temperature as a dashed line, and the vortex chart plots
  both models' winds at 60°.

## Layers

| Group | Layer | Field |
|---|---|---|
| Surface | Temperature, precipitation (rain/snow), cloud, sea-level pressure, wind | 0.25° / 0.5° |
| Upper air | Jet stream (250 hPa), 500 hPa height | 0.5° |
| Stratosphere | Polar vortex (10 hPa height), 10 hPa temperature, 10 hPa wind | 0.5° |

Wind particles follow the level that matches the layer (10 m, 250 hPa or 10 hPa).

## Polar vortex diagnostics (`backend/vortex.py`)

- **Wind at 60°**: zonal-mean zonal wind at 60° and 10 hPa. When it reverses below 0 m/s,
  that is the standard definition of a major sudden stratospheric warming.
- **Vortex edge**: the 10 hPa height contour with the strongest mean wind along it, drawn as
  a white line on the globe.
- **Centre, area, aspect ratio, pieces**: these classify the vortex as displaced
  (centre south of 66°) or split (two or more large pieces).

**Normals:** `web/assets/vortex_climatology.json` holds 1991–2020 daily statistics of the
wind at 60° and the polar cap temperature, built once from NCEP/NCAR Reanalysis 1 (NOAA PSL)
by `python -m backend.climatology` (about 20 minutes, because the server rate-limits
requests). The chart shades the 10th–90th percentile band, with the mean as a dashed line.
The panel shows each forecast's anomaly and percentile. Strength is labelled against those
normals: strong is the top 10% for the date, weak is the bottom 10%, and everything else is
normal. If the file is missing, the labels fall back to fixed thresholds.

Reanalysis 1 is coarser than modern reanalyses such as ERA5. Use it as context for whether
the vortex is unusually strong or weak, not as an exact baseline.

Forecast skill drops off after about 7–10 days, and the timeline marks those steps as lower
confidence.

## Layout

- `backend/gfs.py`: finds the run, downloads, decodes GRIB2, quantises fields to `data/runs/<run>/`
- `backend/ecmwf.py`: same pipeline for ECMWF open data, into `data/ecmwf/`
- `backend/climatology.py`: one-off build of the 1991–2020 vortex normals
- `backend/vortex.py`: polar vortex diagnostics, writes `vortex.json`
- `backend/server.py`: static server, `/api/status`, `/api/point` (16-day meteogram), auto-updater
- `web/`: Three.js globe (`js/globe.js`), particles, layers, charts

Imagery: NASA Blue Marble Next Generation (Dec 2004) and Black Marble 2016. Borders: Natural Earth via world-atlas.
