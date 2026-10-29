import * as THREE from 'three';
import { Globe, latLonToVec3 } from './globe.js';
import { Particles } from './particles.js';
import { DataStore, getJSON, sampleGrid } from './data.js';
import { LAYERS, WIND_LEVELS, DIFF_RANGE, buildColormap, legendTicks, fmt, unitLabel, units } from './layers.js';
import { drawVortexChart, drawPointChart, STATE_INFO } from './charts.js';
import { loadClimatology, hasClimatology, climFor, percentile, percentileText } from './climatology.js';

const $ = id => document.getElementById(id);
const globe = new Globe($('globe'));
const particles = new Particles(globe.scene, globe.camera);
const store = new DataStore();                 // GFS: drives the timeline (16 days)
const ecStore = new DataStore('/data/ecmwf');  // ECMWF: matched to GFS steps by valid time (10 days)
window.weatherGlobe = { globe, particles, store, ecStore }; // handy for console debugging

const state = {
  layer: LAYERS.find(l => l.id === 'vortex'),
  model: 'gfs',    // 'gfs' | 'ecmwf' | 'diff'
  step: 0,
  hemi: 'nh',
  playing: false,
  contours: true,
  current: null,   // { values, nx, ny, gfs?, ec? } of the displayed layer
  point: null,     // last clicked point
  pointData: null,
  pointEc: null,
};

const MODEL_NAME = { gfs: 'GFS', ecmwf: 'ECMWF', diff: 'GFS − ECMWF' };
const validAt = idx => store.manifest.steps[idx].valid;
const ecIndex = idx => (ecStore.manifest ? ecStore.stepAt(validAt(idx)) : -1);

// ---------------------------------------------------------------- layers UI
function buildLayerList() {
  const list = $('layerList');
  const groups = [...new Set(LAYERS.map(l => l.group))];
  for (const g of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'layer-group';
    wrap.innerHTML = `<div class="kicker">${g}</div>`;
    for (const l of LAYERS.filter(x => x.group === g)) {
      const b = document.createElement('button');
      b.className = 'layer-btn';
      b.dataset.id = l.id;
      b.innerHTML = `<span>${l.label}</span><span class="sub">${l.sub}</span>`;
      b.onclick = () => setLayer(l.id);
      wrap.append(b);
    }
    list.append(wrap);
  }
}

/** Colour scale for the active layer and model mode: [cmapName, range, gamma]. */
function activeScale() {
  const L = state.layer;
  if (state.model === 'diff') {
    const r = DIFF_RANGE[L.id];
    return ['diff', [-r, r], 1];
  }
  return [L.cmap, L.range, L.gamma ?? 1];
}

function applyColormap() {
  const L = state.layer;
  const [cmap, range, gamma] = activeScale();
  globe.setColormap('cmap', buildColormap(cmap, range, gamma));
  const aux = state.model !== 'diff' && L.cmapAux;
  if (aux) globe.setColormap('cmapAux', buildColormap(L.cmapAux, range, gamma));
  const u = globe.uniforms;
  u.useAuxCmap.value = !!aux;
  u.range.value.set(range[0], range[1]);
  u.gamma.value = gamma;
}

function setLayer(id) {
  state.layer = LAYERS.find(l => l.id === id);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  applyColormap();
  $('btnVortexLayer').textContent = state.layer.wind === 'strat' ? 'Show surface temps' : 'Show vortex layer';
  drawLegend();
  update();
}

function setModel(model) {
  state.model = model;
  $('modelToggle').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.model === model));
  applyColormap();
  drawLegend();
  update();
}

function drawLegend() {
  const L = state.layer;
  const [cmap, [lo, hi], g] = activeScale();
  const rgba = buildColormap(cmap, [lo, hi], g, 300);
  const cv = $('legendBar'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#1b2433';
  ctx.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]},${rgba[i * 4 + 3] / 255})`;
    ctx.fillRect(i, 0, 1, cv.height);
  }
  // Differences are offsets, so temperature uses a scale-only conversion.
  const qty = state.model === 'diff' && L.qty === 'temp' ? 'tempDelta' : L.qty;
  $('legendTicks').innerHTML = legendTicks(qty, lo, hi, g).map(({ base, label }) => {
    const t = Math.pow((base - lo) / (hi - lo), g) * 100;
    return `<span style="left:${t}%">${label}</span>`;
  }).join('');
  const level = WIND_LEVELS[L.wind];
  const prefix = state.model === 'gfs' ? '' : state.model === 'ecmwf' ? 'ECMWF · ' : 'GFS − ECMWF · ';
  $('legendTitle').textContent = `${prefix}${L.label} · ${L.sub} (${unitLabel(L.qty)})` +
    (particles.visible ? ` — flow: ${level.label}` : '');
}

// ---------------------------------------------------------------- data
let updateToken = 0;
async function update() {
  if (!store.manifest) return;
  const token = ++updateToken;
  const L = state.layer, idx = state.step;
  const level = WIND_LEVELS[L.wind];
  const names = [...L.fields];
  if (L.vortexEdge && !names.includes('z10')) names.push('z10');
  const windNames = [level.u, level.v];
  const ecIdx = ecIndex(idx);
  const has = (s, i) => i >= 0 && names.every(n => s.hasField(i, n));

  const useEc = state.model === 'ecmwf';
  const diff = state.model === 'diff';
  const primary = useEc ? ecStore : store;
  const pIdx = useEc ? ecIdx : idx;
  const ok = diff ? has(store, idx) && has(ecStore, ecIdx) : has(primary, pIdx);
  // Particles follow the displayed model where it has data, otherwise GFS.
  const windSrc = useEc && ecIdx >= 0 ? [ecStore, ecIdx] : [store, idx];

  const [f, f2, w] = await Promise.all([
    ok ? primary.fields(pIdx, names) : null,
    ok && diff ? ecStore.fields(ecIdx, names) : null,
    windSrc[0].fields(windSrc[1], windNames).catch(() => null),
  ]).catch(e => { console.error(e); return [null, null, null]; });
  if (token !== updateToken) return;

  if (f) {
    const m = primary.meta(L.fields[0]);
    let values = L.derive(f), aux = null, parts = null;
    if (diff) {
      const g = values, e = L.derive(f2);
      values = new Float32Array(g.length);
      for (let i = 0; i < g.length; i++) values[i] = g[i] - e[i];
      parts = { gfs: g, ec: e };
    } else {
      aux = L.aux ? L.aux(f) : null;
      if (L.vortexEdge) {
        const z = f.z10, zm = primary.meta('z10');
        aux = new Float32Array(z.length);
        if (zm.nx === m.nx) for (let i = 0; i < z.length; i++) aux[i] = z[i] / 10;
      }
    }
    globe.setData(values, aux, m.nx, m.ny);
    state.current = { values, nx: m.nx, ny: m.ny, ...parts };
  } else {
    globe.uniforms.hasData.value = 0;
    state.current = null;
  }
  if (w) {
    const wm = windSrc[0].meta(level.u);
    particles.setField(w[level.u], w[level.v], wm.nx, wm.ny, level);
  }

  const u = globe.uniforms;
  u.contourInterval.value = state.contours && L.contour && !diff ? L.contour : 0;
  const vsrc = useEc ? ecStore.vortex : store.vortex;
  const valid = validAt(idx);
  const vn = vsrc?.nh.find(x => x.valid === valid), vsh = vsrc?.sh.find(x => x.valid === valid);
  u.edgeOn.value = !!(L.vortexEdge && !diff && vn && vsh);
  if (vn) u.edgeN.value = vn.edge / 10;
  if (vsh) u.edgeS.value = vsh.edge / 10;

  globe.setSun(new Date(valid));
  updateTimeLabel();
  renderVortex();
  updateMarker();
  drawLegend();
  if (!f) $('readout').textContent = unavailableText(idx, ecIdx);
  if (state.pointData) renderPoint();

  // Prefetch neighbouring steps for smooth scrubbing / playback.
  for (const k of [idx + 1, idx + 2, idx - 1]) {
    if (k < 0 || k >= store.manifest.steps.length) continue;
    const ek = ecIndex(k);
    for (const n of [...names, ...windNames]) {
      if (!useEc && store.hasField(k, n)) store.field(k, n).catch(() => {});
      if ((useEc || diff) && ek >= 0 && ecStore.hasField(ek, n)) ecStore.field(ek, n).catch(() => {});
    }
  }
}

function unavailableText(idx, ecIdx) {
  const L = state.layer;
  if (state.model !== 'gfs' && !ecStore.manifest) return 'ECMWF data is still downloading…';
  if (state.model !== 'gfs' && ecIdx < 0) {
    const last = ecStore.manifest.steps.at(-1);
    return `ECMWF runs out to 10 days (${new Date(last.valid).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}). Switch to GFS for later days.`;
  }
  return `${L.label} is not available at this step (analysis time).`;
}

// ---------------------------------------------------------------- time
function setupTimeline() {
  const steps = store.manifest.steps;
  const s = $('timeSlider');
  s.max = steps.length - 1;
  s.value = state.step;
  s.oninput = () => { state.step = +s.value; update(); };
  const ticks = $('dayTicks');
  ticks.innerHTML = '';
  steps.forEach((st, i) => {
    const d = new Date(st.valid);
    if (d.getUTCHours() === 0) {
      const sp = document.createElement('span');
      sp.style.left = `${(i / (steps.length - 1)) * 100}%`;
      sp.textContent = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
      if (st.fh > 240) sp.className = 'uncertain';
      ticks.append(sp);
    }
  });
}

function updateTimeLabel() {
  const st = store.manifest.steps[state.step];
  const d = new Date(st.valid);
  $('timeSlider').value = state.step;
  $('validLocal').textContent = d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  $('validUtc').textContent = `${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`;
  const conf = st.fh > 240 ? ' · low confidence' : st.fh > 144 ? ' · moderate confidence' : '';
  let lead = st.fh === 0 ? 'Analysis (now-cast)' : `+${st.fh} h (${(st.fh / 24).toFixed(1)} d)${conf}`;
  const ek = ecIndex(state.step);
  if (state.model !== 'gfs' && ek >= 0) lead += ` · ECMWF +${ecStore.manifest.steps[ek].fh} h`;
  $('leadTime').textContent = lead;
}

async function playLoop() {
  while (state.playing) {
    const t0 = performance.now();
    state.step = (state.step + 1) % store.manifest.steps.length;
    await update();
    await new Promise(r => setTimeout(r, Math.max(0, 650 - (performance.now() - t0))));
  }
}

function togglePlay(on = !state.playing) {
  state.playing = on;
  $('btnPlay').textContent = on ? '❚❚' : '▶';
  if (on) playLoop();
}

// ---------------------------------------------------------------- vortex
const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
const markers = [0, 1, 2].map(() => {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.016, 0.024, 48), markerMat);
  m.add(new THREE.Mesh(new THREE.CircleGeometry(0.006, 24), markerMat));
  m.visible = false;
  globe.markerGroup.add(m);
  return m;
});

const seriesOf = s => s.vortex?.[state.hemi] ?? [];
const atValid = (series, valid) => series.find(s => s.valid === valid);

/** Vortex diagnostics for the model being shown (ECMWF where it covers the time). */
function activeVortex() {
  const valid = validAt(state.step);
  if (state.model === 'ecmwf') {
    const v = atValid(seriesOf(ecStore), valid);
    if (v) return { v, model: 'ECMWF', series: seriesOf(ecStore) };
  }
  return { v: atValid(seriesOf(store), valid), model: 'GFS', series: seriesOf(store) };
}

function updateMarker() {
  // One marker per vortex piece (so a split shows each daughter vortex).
  const { v } = activeVortex();
  const show = v && state.layer.wind === 'strat' && state.model !== 'diff';
  const centres = !show ? [] : v.pieces > 1 && v.pieceCentroids ? v.pieceCentroids : v.centroid ? [v.centroid] : [];
  markers.forEach((m, i) => {
    m.visible = i < centres.length;
    if (!m.visible) return;
    const p = latLonToVec3(centres[i][0], centres[i][1], 1.004);
    m.position.copy(p);
    m.lookAt(p.clone().multiplyScalar(2));
  });
}

/** Strength label relative to the 1991–2020 normal; shape/reversal states take priority. */
function climateState(v, key, date) {
  if (!['strong', 'moderate', 'weak'].includes(v.state)) return v.state;
  const pct = percentile(key, date, v.u60);
  if (pct == null) return v.state;
  return pct >= 90 ? 'strong' : pct <= 10 ? 'weak' : 'normal';
}

function signed(x, digits = 1) { return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}`; }
function tempDelta(k) {
  return units.system === 'imperial' ? `${signed(k * 9 / 5)} °F` : `${signed(k)} °C`;
}

function renderVortex() {
  const gSeries = seriesOf(store), eSeries = seriesOf(ecStore);
  const key = state.hemi === 'nh' ? 'u60n' : 'u60s';
  const tkey = state.hemi === 'nh' ? 'tcapn' : 'tcaps';
  const steps = store.manifest.steps;
  const t0 = Date.parse(steps[0].valid), t1 = Date.parse(steps.at(-1).valid);
  const pts = s => s.map(x => ({ t: Date.parse(x.valid), v: x.u60, state: x.state }));
  const clim = hasClimatology() ? steps.map(st => {
    const c = climFor(key, new Date(st.valid));
    return c && { t: Date.parse(st.valid), lo: c.p[2], hi: c.p[6], mean: c.mean };
  }).filter(Boolean) : [];
  $('climLegend').classList.toggle('hidden', !clim.length);
  drawVortexChart($('vortexChart'), {
    t0, t1, clim,
    lines: [
      { label: 'GFS', color: '#6cc4ff', points: pts(gSeries) },
      { label: 'ECMWF', color: '#f6ad57', points: pts(eSeries) },
    ],
    cursor: Date.parse(validAt(state.step)),
    onPick: t => {
      let best = 0;
      steps.forEach((s, i) => { if (Math.abs(Date.parse(s.valid) - t) < Math.abs(Date.parse(steps[best].valid) - t)) best = i; });
      state.step = best;
      update();
    },
  });

  const { v, model } = activeVortex();
  if (!v) { $('vortexState').textContent = 'No data'; $('vortexStats').innerHTML = ''; return; }
  const date = new Date(v.valid);
  const st = climateState(v, key, date);
  const info = STATE_INFO[st];
  $('vortexState').innerHTML = `${state.hemi === 'nh' ? 'Arctic' : 'Antarctic'}<span class="badge" style="background:${info.color}26;color:${info.color};border:1px solid ${info.color}66">${info.label}</span>`;

  const ll = c => `${Math.abs(c[0]).toFixed(1)}°${c[0] >= 0 ? 'N' : 'S'} ${Math.abs(c[1]).toFixed(1)}°${c[1] >= 0 ? 'E' : 'W'}`;
  const latlon = v.pieces > 1 && v.pieceCentroids ? v.pieceCentroids.map(ll).join('<br>') : v.centroid ? ll(v.centroid) : '—';
  const other = model === 'GFS' ? atValid(eSeries, v.valid) : atValid(gSeries, v.valid);
  const otherName = model === 'GFS' ? 'ECMWF' : 'GFS';

  const c = climFor(key, date), ct = climFor(tkey, date);
  const pct = percentile(key, date, v.u60);
  const firstRev = s => {
    const r = s.find(x => x.state === 'reversed');
    return r ? `${new Date(r.valid).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'none';
  };
  const eLast = eSeries.at(-1);
  const ecRev = eSeries.length ? `${firstRev(eSeries)}${firstRev(eSeries) === 'none' ? ` (to ${new Date(eLast.valid).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})` : ''}` : '—';

  const rows = [
    ['Status', info.text],
    [`Wind at 60° (${model})`, `${fmt('ms', v.u60)} ${v.u60 >= 0 ? 'westerly' : 'easterly'}`],
    other ? [`Wind at 60° (${otherName})`, fmt('ms', other.u60)] : null,
    c ? ['vs 1991–2020 normal', `${signed(v.u60 - c.mean)} m/s · ${percentileText(pct)}`] : null,
    ['Polar cap temp', `${fmt('K', v.tcap)}${ct ? ` (${tempDelta(v.tcap - ct.mean)} vs normal)` : ''}`],
    [v.pieces > 1 ? 'Vortex centres' : 'Vortex centre', latlon],
    ['Area', `${v.areaMkm2.toFixed(1)} million km²`],
    ['Shape (aspect)', v.aspect ? `${v.aspect.toFixed(2)} : 1` : '—'],
    ['Wind reversal', `GFS ${firstRev(gSeries)} · ECMWF ${ecRev}`],
  ].filter(Boolean);
  $('vortexStats').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd${k === 'Status' ? ' style="font-family:inherit"' : ''}>${val}</dd>`).join('');
}

// ---------------------------------------------------------------- picking
let hoverQueued = null;
function onHover(e) {
  hoverQueued = e;
}
function processHover() {
  const e = hoverQueued; hoverQueued = null;
  if (!e || !store.manifest) return;
  const ll = globe.pick(e.clientX, e.clientY);
  if (!ll) return;
  const pos = `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'} ${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}`;
  if (!state.current) { $('readout').textContent = pos; return; }
  const c = state.current, q = state.layer.qty;
  const at = arr => sampleGrid(arr, c.nx, c.ny, ll.lat, ll.lon);
  if (c.gfs) {
    const g = at(c.gfs), ec = at(c.ec), d = g - ec;
    const dTxt = q === 'temp' ? tempDelta(d) : `${d >= 0 ? '+' : '−'}${fmt(q, Math.abs(d))}`;
    $('readout').textContent = `${pos} · GFS ${fmt(q, g)} · ECMWF ${fmt(q, ec)} · Δ ${dTxt}`;
  } else {
    $('readout').textContent = `${pos} · ${fmt(q, at(c.values))}`;
  }
}

let downAt = null;
$('globe').addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
$('globe').addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const ll = globe.pick(e.clientX, e.clientY);
  if (ll) openPoint(ll.lat, ll.lon);
});
$('globe').addEventListener('pointermove', onHover);

async function openPoint(lat, lon) {
  state.point = { lat, lon };
  $('pointPanel').classList.remove('hidden');
  $('pointTitle').textContent = `16-day forecast · ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  $('pointNow').textContent = 'Loading…';
  const q = `lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
  const [data, ec] = await Promise.all([
    getJSON(`/api/point?${q}`),
    getJSON(`/api/point?${q}&model=ecmwf`).catch(() => null),
  ]);
  if (!data || data.error) { $('pointNow').textContent = data?.error ?? 'Failed to load'; return; }
  state.pointData = data;
  state.pointEc = ec && !ec.error ? ec : null;
  renderPoint();
}

function renderPoint() {
  const d = state.pointData, ec = state.pointEc;
  const valid = validAt(state.step);
  const i = Math.max(0, d.valid.indexOf(valid));
  const ei = ec ? ec.valid.indexOf(valid) : -1;
  const wind = d.u10m[i] != null ? Math.hypot(d.u10m[i], d.v10m[i]) : null;
  const dir = d.u10m[i] != null ? (Math.atan2(-d.u10m[i], -d.v10m[i]) * 180 / Math.PI + 360) % 360 : null;
  const compass = dir == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(dir / 45) % 8];
  const pr = d.prate[i] != null ? d.prate[i] * 3600 : null;
  const ecTemp = ei >= 0 && ec.t2m[ei] != null ? ` <span class="muted">(ECMWF ${fmt('K', ec.t2m[ei])})</span>` : '';
  $('pointNow').innerHTML = [
    ['Temp', fmt('K', d.t2m[i]) + ecTemp],
    ['Precip', pr == null ? '—' : `${fmt('precip', pr)}${d.csnow[i] > 0.5 && pr > 0.05 ? ' snow' : ''}`],
    ['Wind', wind == null ? '—' : `${fmt('speed', wind)} ${compass}`],
    ['Cloud', fmt('pct', d.tcc[i])],
    ['Pressure', fmt('pres', d.prmsl[i] / 100)],
  ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  $('pointCaption').textContent = drawPointChart($('pointChart'), d, valid, ec);
}

$('pointClose').onclick = () => { $('pointPanel').classList.add('hidden'); state.pointData = null; };

// ---------------------------------------------------------------- options
function setupOptions() {
  $('optParticles').onchange = e => { particles.visible = e.target.checked; drawLegend(); };
  $('optContours').onchange = e => { state.contours = e.target.checked; update(); };
  $('optBorders').onchange = e => { globe.borders.visible = e.target.checked; };
  $('optDaylight').onchange = e => { globe.uniforms.daylight.value = e.target.checked; };
  $('optGraticule').onchange = e => { globe.uniforms.graticule.value = e.target.checked; };
  $('optOpacity').oninput = e => { globe.uniforms.opacity.value = +e.target.value; };
  $('modelToggle').onclick = e => {
    const b = e.target.closest('button'); if (b) setModel(b.dataset.model);
  };
  $('unitToggle').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    units.system = b.dataset.units;
    $('unitToggle').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    drawLegend(); renderVortex(); if (state.pointData) renderPoint();
  };
  $('hemiToggle').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    state.hemi = b.dataset.hemi;
    $('hemiToggle').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderVortex(); updateMarker();
  };
  $('btnPole').onclick = () => {
    const { v } = activeVortex();
    const lat = state.hemi === 'nh' ? 89.5 : -89.5;
    globe.flyTo(lat, v?.centroid?.[1] ?? 0, 2.6);
    if (state.layer.wind !== 'strat') setLayer('vortex');
  };
  $('btnVortexLayer').onclick = () => setLayer(state.layer.wind === 'strat' ? 'temp' : 'vortex');
  $('btnPlay').onclick = () => togglePlay();
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const n = store.manifest?.steps.length;
    if (!n) return;
    if (e.key === 'ArrowRight') { state.step = Math.min(n - 1, state.step + 1); update(); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { state.step = Math.max(0, state.step - 1); update(); e.preventDefault(); }
    if (e.key === ' ') { togglePlay(); e.preventDefault(); }
  });
}

// ---------------------------------------------------------------- status / auto-update
function runLabel(m) {
  const d = new Date(m.runTime);
  const hrs = (Date.now() - d.getTime()) / 3.6e6;
  const name = m.model.includes('ECMWF') ? 'ECMWF' : 'GFS';
  return `${name} ${String(d.getUTCHours()).padStart(2, '0')}Z ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} ·${hrs.toFixed(0)} h old${m.complete ? '' : ' · downloading…'}`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 5000);
}

async function pollStatus() {
  const st = await getJSON('/api/status').catch(() => null);
  const line = $('statusLine');
  if (!st) { line.textContent = 'Server unreachable'; line.className = 'status error'; return; }
  const busy = [['GFS', st], ['ECMWF', st.ecmwf]].filter(([, s]) => s && s.state !== 'idle');
  line.className = 'status' + (busy.some(([, s]) => s.state === 'error') ? ' error' : '');
  line.textContent = busy.map(([n, s]) => s.state === 'downloading' ? `Fetching ${n} ${s.run}: ${s.done}/${s.total}` : s.message).join(' · ');

  let changed = false;
  if (st.latest && (!store.manifest || st.latest !== store.manifest.run || !store.manifest.complete)) {
    const prevValid = store.manifest?.steps[state.step]?.valid;
    const prevRun = store.manifest?.run;
    await store.loadLatest();
    const steps = store.manifest.steps;
    const keep = prevValid ? steps.findIndex(s => s.valid === prevValid) : -1;
    state.step = keep >= 0 ? keep : Math.min(state.step, steps.length - 1);
    setupTimeline();
    if (prevRun && prevRun !== store.manifest.run) toast(`New forecast loaded: GFS ${store.manifest.runTime.replace('T', ' ')}`);
    changed = true;
  }
  const ecLatest = st.ecmwf?.latest;
  if (ecLatest && ecLatest !== ecStore.manifest?.run) {
    const prevRun = ecStore.manifest?.run;
    await ecStore.loadLatest();
    if (prevRun) toast(`New forecast loaded: ECMWF ${ecStore.manifest.runTime.replace('T', ' ')}`);
    changed = true;
  }
  if (changed && store.manifest) update();
  if (store.manifest) {
    $('runInfo').innerHTML = [store.manifest, ecStore.manifest].filter(Boolean).map(runLabel).join('<br>');
  }
}

// ---------------------------------------------------------------- main loop
function frame(now) {
  if (hoverQueued) processHover();
  particles.step();
  globe.render(now);
  requestAnimationFrame(frame);
}

async function main() {
  buildLayerList();
  setupOptions();
  setLayer(state.layer.id);
  requestAnimationFrame(frame);
  await loadClimatology();
  await pollStatus();
  if (!store.manifest) $('runInfo').textContent = 'Waiting for the first forecast download…';
  setInterval(pollStatus, 15000);
}
main();
