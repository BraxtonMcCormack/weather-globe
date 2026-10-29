// Loads run manifests and decodes quantised GFS field grids into Float32Arrays.

const MAX_CACHE = 90;

export class DataStore {
  constructor(base = '/data') {
    this.base = base;
    this.manifest = null;
    this.vortex = null;
    this.cache = new Map(); // key -> Promise<Float32Array>
  }

  async loadLatest() {
    const latest = await getJSON(`${this.base}/latest.json`);
    if (!latest) return null;
    const manifest = await getJSON(`${this.base}/runs/${latest.run}/manifest.json`);
    const vortex = await getJSON(`${this.base}/runs/${latest.run}/vortex.json`);
    if (this.manifest?.run !== manifest.run) this.cache.clear();
    this.manifest = manifest;
    this.vortex = vortex;
    return manifest;
  }

  meta(field) { return this.manifest.fields[field]; }

  /** Index of the step valid at the given ISO time, or -1. */
  stepAt(valid) {
    return this.manifest ? this.manifest.steps.findIndex(s => s.valid === valid) : -1;
  }

  hasField(stepIdx, field) {
    return this.manifest.steps[stepIdx]?.fields.includes(field);
  }

  field(stepIdx, field) {
    const step = this.manifest.steps[stepIdx];
    const key = `${this.base}/${this.manifest.run}/${step.fh}/${field}`;
    if (this.cache.has(key)) {
      const p = this.cache.get(key);
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, p);
      return p;
    }
    const m = this.meta(field);
    const url = `${this.base}/runs/${this.manifest.run}/f${String(step.fh).padStart(3, '0')}/${field}.bin`;
    const p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`${field} missing for +${step.fh}h`);
      return r.arrayBuffer();
    }).then(buf => decode(buf, m));
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
    return p;
  }

  async fields(stepIdx, names) {
    const arrs = await Promise.all(names.map(n => this.field(stepIdx, n)));
    return Object.fromEntries(names.map((n, i) => [n, arrs[i]]));
  }
}

function decode(buf, m) {
  const raw = m.dtype === 'u2' ? new Uint16Array(buf) : new Uint8Array(buf);
  const top = m.dtype === 'u2' ? 65535 : 255;
  const scale = (m.max - m.min) / top;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = m.min + raw[i] * scale;
  return out;
}

export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

/** Bilinear sample of a regular lat/lon grid (row 0 = 90N, col 0 = 0E). */
export function sampleGrid(arr, nx, ny, lat, lon) {
  const res = 180 / (ny - 1);
  const y = Math.min(ny - 1, Math.max(0, (90 - lat) / res));
  let x = (((lon % 360) + 360) % 360) / res;
  const x0 = Math.floor(x), y0 = Math.min(ny - 2, Math.floor(y));
  const fx = x - x0, fy = y - y0;
  const x1 = (x0 + 1) % nx, xa = x0 % nx;
  const r0 = y0 * nx, r1 = (y0 + 1) * nx;
  return (arr[r0 + xa] * (1 - fx) + arr[r0 + x1] * fx) * (1 - fy)
       + (arr[r1 + xa] * (1 - fx) + arr[r1 + x1] * fx) * fy;
}
