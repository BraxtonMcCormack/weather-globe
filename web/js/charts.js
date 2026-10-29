// Small SVG charts: polar vortex wind timeline and the point meteogram.
import { fmt, unitLabel, units } from './layers.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};

export const STATE_INFO = {
  strong:    { label: 'Strong',    color: '#6cc4ff', text: 'Vortex is strong and centred over the pole; cold air stays locked in the Arctic.' },
  moderate:  { label: 'Moderate',  color: '#52d18a', text: 'Vortex is intact with moderate westerly winds.' },
  weak:      { label: 'Weak',      color: '#ffb547', text: 'Westerlies are weak; the vortex is vulnerable to disruption.' },
  displaced: { label: 'Displaced', color: '#ff9147', text: 'Vortex centre has shifted well off the pole.' },
  split:     { label: 'Split',     color: '#ff5d6c', text: 'Vortex has split into two or more pieces.' },
  reversed:  { label: 'Reversed',  color: '#ff4fd8', text: 'Winds at 60° have turned easterly: a major sudden stratospheric warming.' },
};

STATE_INFO.normal = { label: 'Normal', color: '#52d18a', text: 'Vortex winds are within the usual range for the date.' };

/**
 * Zonal-mean wind at 60° against valid time.
 * opts: { t0, t1 (ms), lines: [{ label, color, points: [{ t, v, state }] }],
 *         clim: [{ t, lo, hi, mean }], cursor (ms), onPick(ms) }
 */
export function drawVortexChart(svg, opts) {
  svg.replaceChildren();
  const { t0, t1, lines, clim = [], cursor, onPick } = opts;
  if (!lines.some(l => l.points.length)) return;
  const W = 300, H = 120, L = 26, R = 4, T = 6, B = 16;
  const vals = [...lines.flatMap(l => l.points.map(p => p.v)), ...clim.flatMap(c => [c.lo, c.hi])];
  const lo = Math.min(-10, Math.floor(Math.min(...vals) / 10) * 10);
  const hi = Math.max(40, Math.ceil(Math.max(...vals) / 10) * 10);
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  // Reversal band below zero.
  svg.append(el('rect', { x: L, y: y(0), width: W - L - R, height: y(lo) - y(0), fill: 'rgba(255,79,216,0.10)' }));
  for (let v = lo; v <= hi; v += 10) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v),
      stroke: v === 0 ? 'rgba(255,79,216,0.8)' : 'rgba(255,255,255,0.07)', 'stroke-width': v === 0 ? 1.2 : 1 }));
    svg.append(el('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end' }, v));
  }
  // Day ticks every 2 days from the first valid time.
  for (let d = 0; t0 + d * 86400000 <= t1; d += 2) {
    svg.append(el('text', { x: x(t0 + d * 86400000), y: H - 3, 'text-anchor': 'middle' }, `${d}d`));
  }
  // 1991–2020 normal: 10th–90th percentile band and mean.
  if (clim.length) {
    const band = clim.map((c, i) => `${i ? 'L' : 'M'}${x(c.t).toFixed(1)},${y(c.hi).toFixed(1)}`).join('') +
      [...clim].reverse().map(c => `L${x(c.t).toFixed(1)},${y(c.lo).toFixed(1)}`).join('') + 'Z';
    svg.append(el('path', { d: band, fill: 'rgba(255,255,255,0.08)' }));
    svg.append(el('path', { d: path(clim.map(c => ({ t: c.t, v: c.mean }))), fill: 'none',
      stroke: 'rgba(255,255,255,0.45)', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
  }
  lines.forEach((l, li) => {
    if (!l.points.length) return;
    svg.append(el('path', { d: path(l.points), fill: 'none', stroke: l.color,
      'stroke-width': li === 0 ? 1.9 : 1.5, 'stroke-linejoin': 'round', 'stroke-dasharray': l.dash ?? '' }));
    l.points.forEach(p => {
      if (p.state === 'reversed' || p.state === 'split' || p.state === 'displaced') {
        svg.append(el('circle', { cx: x(p.t), cy: y(p.v), r: 1.7, fill: STATE_INFO[p.state].color }));
      }
    });
  });
  if (cursor != null) {
    svg.append(el('line', { x1: x(cursor), x2: x(cursor), y1: T, y2: H - B, stroke: '#fff', 'stroke-opacity': 0.6 }));
    const cur = lines[0].points.find(p => p.t === cursor);
    if (cur) svg.append(el('circle', { cx: x(cursor), cy: y(cur.v), r: 3.5, fill: '#fff' }));
  }
  // Click to jump in time.
  const hit = el('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent', style: 'cursor:pointer' });
  hit.addEventListener('click', e => {
    const r = svg.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, ((e.clientX - r.left) / r.width * W - L) / (W - L - R)));
    onPick?.(t0 + fx * (t1 - t0));
  });
  svg.append(hit);
}

/** Meteogram: temperature line, precipitation bars, cloud band, wind; optional ECMWF temperature overlay. */
export function drawPointChart(svg, data, currentValid, ec = null) {
  svg.replaceChildren();
  const W = 340, H = 170, L = 30, R = 30, T = 18, B = 18;
  const n = data.valid.length;
  const x = i => L + (i / (n - 1)) * (W - L - R);
  const temps = data.t2m.map(k => k == null ? null : k - 273.15);
  // ECMWF temperatures aligned to the GFS valid times (null where ECMWF has no step).
  const ecTemps = ec ? data.valid.map(v => {
    const j = ec.valid.indexOf(v);
    return j >= 0 && ec.t2m[j] != null ? ec.t2m[j] - 273.15 : null;
  }) : [];
  const conv = v => units.system === 'imperial' ? v * 9 / 5 + 32 : v;
  const tv = [...temps, ...ecTemps].filter(v => v != null).map(conv);
  const tlo = Math.floor(Math.min(...tv) - 2), thi = Math.ceil(Math.max(...tv) + 2);
  const yT = v => T + (1 - (v - tlo) / (thi - tlo)) * (H - T - B - 22);
  const precip = data.prate.map(v => v == null ? 0 : v * 3600);
  const pmax = Math.max(2, ...precip);
  const barBase = H - B - 22;

  // Cloud cover band across the top.
  data.tcc.forEach((c, i) => {
    if (c == null || i === n - 1) return;
    svg.append(el('rect', { x: x(i), y: 2, width: x(i + 1) - x(i) + 0.5, height: 10,
      fill: `rgba(220,230,245,${(c / 100) * 0.85})` }));
  });
  svg.append(el('text', { x: L - 4, y: 10, 'text-anchor': 'end' }, 'cloud'));

  // Day separators, labelled every other day.
  let day = 0;
  data.valid.forEach((v, i) => {
    const d = new Date(v);
    if (d.getUTCHours() === 0) {
      svg.append(el('line', { x1: x(i), x2: x(i), y1: T, y2: H - B, stroke: 'rgba(255,255,255,0.07)' }));
      if (day++ % 2 === 0) {
        svg.append(el('text', { x: x(i), y: H - 4, 'text-anchor': 'middle' },
          d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })));
      }
    }
  });

  // Precipitation bars (right axis).
  precip.forEach((p, i) => {
    if (p < 0.05) return;
    const h = (p / pmax) * (barBase - T) * 0.6;
    const snow = data.csnow[i] > 0.5;
    svg.append(el('rect', { x: x(i) - 1.6, y: barBase - h, width: 3.2, height: h,
      fill: snow ? '#cfe6ff' : '#3fa0ff', opacity: 0.9 }));
  });
  svg.append(el('text', { x: W - R + 4, y: barBase, 'text-anchor': 'start' }, '0'));
  svg.append(el('text', { x: W - R + 4, y: barBase - (barBase - T) * 0.6 + 8, 'text-anchor': 'start' },
    fmt('precip', pmax, false)));

  // Temperature line (left axis).
  const step = Math.max(2, Math.ceil((thi - tlo) / 5));
  for (let v = Math.ceil(tlo / step) * step; v <= thi; v += step) {
    svg.append(el('line', { x1: L, x2: W - R, y1: yT(v), y2: yT(v), stroke: 'rgba(255,255,255,0.06)' }));
    svg.append(el('text', { x: L - 4, y: yT(v) + 3, 'text-anchor': 'end' }, `${v}°`));
  }
  if (tlo < conv(0) && thi > conv(0)) {
    svg.append(el('line', { x1: L, x2: W - R, y1: yT(conv(0)), y2: yT(conv(0)), stroke: 'rgba(120,200,255,0.5)', 'stroke-dasharray': '3 3' }));
  }
  const linePath = arr => {
    let out = '', pen = false;
    arr.forEach((t, i) => {
      if (t == null) { pen = false; return; }
      out += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${yT(conv(t)).toFixed(1)}`;
      pen = true;
    });
    return out;
  };
  if (ec) {
    svg.append(el('path', { d: linePath(ecTemps), fill: 'none', stroke: '#e7c6ff', 'stroke-width': 1.5,
      'stroke-dasharray': '4 3', 'stroke-linejoin': 'round' }));
  }
  svg.append(el('path', { d: linePath(temps), fill: 'none', stroke: '#ff9a5c', 'stroke-width': 2, 'stroke-linejoin': 'round' }));

  // Wind speed strip along the bottom.
  data.u10m.forEach((u, i) => {
    if (u == null || i === n - 1) return;
    const s = Math.hypot(u, data.v10m[i]);
    const a = Math.min(1, s / 20);
    svg.append(el('rect', { x: x(i), y: H - B - 14, width: x(i + 1) - x(i) + 0.5, height: 8,
      fill: `rgba(${Math.round(80 + 175 * a)},${Math.round(200 - 120 * a)},${Math.round(255 - 180 * a)},${0.25 + 0.7 * a})` }));
  });
  svg.append(el('text', { x: L - 4, y: H - B - 7, 'text-anchor': 'end' }, 'wind'));

  if (currentValid) {
    const i = data.valid.indexOf(currentValid);
    if (i >= 0) svg.append(el('line', { x1: x(i), x2: x(i), y1: T, y2: H - B, stroke: '#fff', 'stroke-opacity': 0.55 }));
  }
  return `Temperature (${unitLabel('temp')}, orange = GFS${ec ? ', dashed lilac = ECMWF' : ''}) · precipitation (${unitLabel('precip')}, blue = rain, white = snow) · wind (bottom strip) · cloud (top band)`;
}
