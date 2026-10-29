// Layer definitions, colour maps and unit conversion.
// Texture values are stored in "base" units (°C, hPa, m/s, mm/h, %, dam);
// unit conversion is only applied to labels.

const ramp = (...colors) => colors.map((c, i) => [i / (colors.length - 1), c]);

export const COLORMAPS = {
  temp: [
    [-50, '#f6ecff'], [-40, '#d6a7f5'], [-30, '#9c63e0'], [-20, '#5856d6'], [-10, '#3b7fe0'],
    [-3, '#49b5ec'], [0, '#8ee0f0'], [4, '#5bc8a2'], [10, '#8fd16a'], [16, '#e8e35a'],
    [22, '#f7b648'], [28, '#ef7a38'], [34, '#d83a32'], [40, '#a3122f'], [48, '#5c0420'],
  ],
  rain: [
    [0, '#2c7cf000'], [0.1, '#4aa0ff55'], [0.4, '#2f86f2b0'], [1, '#1fb24f'], [2.5, '#a6d930'],
    [4, '#f5e000'], [8, '#ff8a00'], [15, '#e8001c'], [25, '#b000b5'], [40, '#ffd6ff'],
  ],
  snow: [
    [0, '#ffffff00'], [0.1, '#dff1ff66'], [0.4, '#c3e2ffcc'], [1, '#9cc8ff'], [2.5, '#7a9cff'],
    [5, '#a37bff'], [10, '#e06cff'], [40, '#ffffff'],
  ],
  clouds: [[0, '#ffffff00'], [15, '#ffffff00'], [40, '#e8eef560'], [70, '#f0f4f8b0'], [100, '#ffffffe8']],
  pressure: [
    [960, '#3b0f6f'], [975, '#3f4fbf'], [990, '#3f8fd8'], [1002, '#8fd0e8'], [1010, '#e7efe9'],
    [1016, '#f3e3a2'], [1024, '#f3a95b'], [1034, '#d9583a'], [1048, '#8e1230'],
  ],
  speed: ramp('#2a3550', '#2c5c9e', '#2a9fb8', '#4cc070', '#d9d83c', '#f2932a', '#dc2f3c', '#a3157a', '#f7d6f7'),
  jet: ramp('#1c2c5000', '#2556a066', '#2a9fc0cc', '#46c26e', '#e0d83c', '#f2902a', '#dc2f3c', '#a3157a', '#f7d6f7'),
  height500: ramp('#3d0a6e', '#3846b4', '#2f8fd6', '#3cc2c0', '#7fd67a', '#e3dc5a', '#f4a245', '#e2553a', '#9c1530'),
  vortex: ramp('#14042e', '#2e0b6e', '#3b2fc0', '#2f7fe6', '#38b9e0', '#8fe0b4', '#efe58a', '#f6ad57', '#e45d3c', '#a11d33'),
  strattemp: ramp('#0b1d51', '#253d9a', '#3f7fd1', '#62c2e0', '#b7e8c8', '#f4e27a', '#f6a04d', '#e0453a', '#8e1230'),
  // Model difference (GFS − ECMWF): blue = GFS lower, red = GFS higher, clear where they agree.
  diff: ramp('#1d3f9e', '#3a78d4', '#7fb3ea', '#cfe2f5aa', '#ffffff00', '#f7d3c4aa', '#f0906a', '#d9473a', '#9c1426'),
};

// Symmetric colour range for the GFS − ECMWF difference view, in base units.
export const DIFF_RANGE = {
  temp: 8, precip: 6, clouds: 60, pressure: 10, wind: 12, jet: 30,
  z500: 12, vortex: 40, strattemp: 10, stratwind: 30,
};

// Each layer: fields to load, how to derive the texture value, colour map and range.
export const LAYERS = [
  { id: 'temp', group: 'Surface', label: 'Temperature', sub: '2 m', fields: ['t2m'],
    derive: f => map(f.t2m, v => v - 273.15), cmap: 'temp', range: [-50, 48], qty: 'temp',
    contour: 0, wind: 'surface' },
  { id: 'precip', group: 'Surface', label: 'Precipitation', sub: 'rate · snow', fields: ['prate', 'csnow'],
    derive: f => map(f.prate, v => v * 3600), aux: f => f.csnow, cmap: 'rain', cmapAux: 'snow',
    range: [0, 40], gamma: 0.5, qty: 'precip', wind: 'surface', base: true },
  { id: 'clouds', group: 'Surface', label: 'Cloud cover', sub: 'total', fields: ['tcc'],
    derive: f => f.tcc, cmap: 'clouds', range: [0, 100], qty: 'pct', wind: 'surface', base: true },
  { id: 'pressure', group: 'Surface', label: 'Pressure', sub: 'sea level', fields: ['prmsl'],
    derive: f => map(f.prmsl, v => v / 100), cmap: 'pressure', range: [960, 1048], qty: 'pres',
    contour: 4, wind: 'surface' },
  { id: 'wind', group: 'Surface', label: 'Wind speed', sub: '10 m', fields: ['u10m', 'v10m'],
    derive: f => speed(f.u10m, f.v10m), cmap: 'speed', range: [0, 35], qty: 'speed', wind: 'surface' },
  { id: 'jet', group: 'Upper air', label: 'Jet stream', sub: '250 hPa', fields: ['u250', 'v250'],
    derive: f => speed(f.u250, f.v250), cmap: 'jet', range: [0, 100], qty: 'speed', wind: 'jet', base: true },
  { id: 'z500', group: 'Upper air', label: '500 hPa height', sub: 'troughs · ridges', fields: ['z500'],
    derive: f => map(f.z500, v => v / 10), cmap: 'height500', range: [490, 600], qty: 'dam',
    contour: 6, wind: 'jet' },
  { id: 'vortex', group: 'Stratosphere', label: 'Polar vortex', sub: '10 hPa height', fields: ['z10'],
    derive: f => map(f.z10, v => v / 10), cmap: 'vortex', range: [2850, 3180], qty: 'dam',
    contour: 16, wind: 'strat', vortexEdge: true },
  { id: 'strattemp', group: 'Stratosphere', label: 'Temperature', sub: '10 hPa', fields: ['t10'],
    derive: f => map(f.t10, v => v - 273.15), cmap: 'strattemp', range: [-90, -20], qty: 'temp',
    contour: 5, wind: 'strat', vortexEdge: true },
  { id: 'stratwind', group: 'Stratosphere', label: 'Wind speed', sub: '10 hPa', fields: ['u10', 'v10'],
    derive: f => speed(f.u10, f.v10), cmap: 'speed', range: [0, 130], qty: 'speed', wind: 'strat',
    vortexEdge: true },
];

export const WIND_LEVELS = {
  surface: { u: 'u10m', v: 'v10m', label: '10 m wind', secondsPerFrame: 2400, maxSpeed: 25 },
  jet: { u: 'u250', v: 'v250', label: '250 hPa wind', secondsPerFrame: 700, maxSpeed: 80 },
  strat: { u: 'u10', v: 'v10', label: '10 hPa wind', secondsPerFrame: 500, maxSpeed: 110 },
};

function map(a, fn) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = fn(a[i]);
  return out;
}

function speed(u, v) {
  const out = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = Math.hypot(u[i], v[i]);
  return out;
}

// --- Units ---------------------------------------------------------------
export const units = { system: 'metric' };

export function fmt(qty, v, withUnit = true) {
  if (v == null || Number.isNaN(v)) return '—';
  const imp = units.system === 'imperial';
  let val, u, d = 0;
  switch (qty) {
    case 'temp': val = imp ? v * 9 / 5 + 32 : v; u = imp ? '°F' : '°C'; break;
    case 'precip': val = imp ? v / 25.4 : v; u = imp ? 'in/h' : 'mm/h'; d = imp ? 2 : 1; break;
    case 'pct': val = v; u = '%'; break;
    case 'pres': val = imp ? v * 0.02953 : v; u = imp ? 'inHg' : 'hPa'; d = imp ? 2 : 0; break;
    case 'speed': val = imp ? v * 2.23694 : v * 3.6; u = imp ? 'mph' : 'km/h'; break;
    case 'ms': val = v; u = 'm/s'; d = 1; break;
    case 'dam': val = v; u = 'dam'; break;
    case 'K': val = imp ? (v - 273.15) * 9 / 5 + 32 : v - 273.15; u = imp ? '°F' : '°C'; d = 1; break;
    default: val = v; u = '';
  }
  const s = val.toFixed(d);
  return withUnit ? `${s} ${u}`.trim() : s;
}

// Linear base-unit -> display-unit conversion as [scale, offset].
function displayLinear(qty) {
  const imp = units.system === 'imperial';
  switch (qty) {
    case 'temp': return imp ? [9 / 5, 32] : [1, 0];
    case 'tempDelta': return imp ? [9 / 5, 0] : [1, 0];
    case 'precip': return imp ? [1 / 25.4, 0] : [1, 0];
    case 'pres': return imp ? [0.02953, 0] : [1, 0];
    case 'speed': return imp ? [2.23694, 0] : [3.6, 0];
    default: return [1, 0];
  }
}

/** Legend ticks at round numbers in display units, returned as base-unit positions. */
export function legendTicks(qty, lo, hi, gamma = 1) {
  const [a, b] = displayLinear(qty);
  const dl = lo * a + b, dh = hi * a + b;
  const ticks = gamma !== 1 && units.system === 'imperial'
    ? [0, 0.05, 0.1, 0.25, 0.5, 1, 1.5].filter(v => v >= dl && v <= dh)
    : niceTicks(dl, dh, gamma, 6);
  return ticks.map(t => ({ base: (t - b) / a, label: String(+t.toFixed(2)) }));
}

export function unitLabel(qty) {
  return fmt(qty, 0).replace(/^-?[\d.]+\s*/, '');
}

// --- Colour map textures ----------------------------------------------------
function parseColor(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** Sample a colour map into an RGBA byte array over [min, max] with optional gamma axis. */
export function buildColormap(name, range, gamma = 1, size = 512) {
  const stops = COLORMAPS[name];
  const [lo, hi] = range;
  // Ramps defined on 0..1 are stretched to the layer range.
  const normalized = stops[stops.length - 1][0] === 1 && stops[0][0] === 0 && hi !== 1;
  const pts = stops.map(([p, c]) => [normalized ? lo + p * (hi - lo) : p, parseColor(c)]);
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    const v = lo + Math.pow(t, 1 / gamma) * (hi - lo);
    let j = 0;
    while (j < pts.length - 2 && v > pts[j + 1][0]) j++;
    const [v0, c0] = pts[j], [v1, c1] = pts[j + 1];
    const f = Math.min(1, Math.max(0, (v - v0) / (v1 - v0 || 1)));
    for (let k = 0; k < 4; k++) out[i * 4 + k] = Math.round(c0[k] + (c1[k] - c0[k]) * f);
  }
  return out;
}

export function niceTicks(lo, hi, gamma = 1, count = 6) {
  if (gamma !== 1) {
    const cands = [0, 1, 2.5, 5, 10, 20, 40, 80].filter(v => v >= lo && v <= hi);
    return cands;
  }
  const span = hi - lo;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}
