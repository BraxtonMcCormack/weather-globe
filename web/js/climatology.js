// 1991–2020 daily climatology of the 10 hPa vortex diagnostics (see backend/climatology.py).
import { getJSON } from './data.js';

let clim = null;

export async function loadClimatology() {
  clim = await getJSON('assets/vortex_climatology.json').catch(() => null);
  return clim;
}

export const hasClimatology = () => !!clim;
export const climSource = () => clim?.source ?? '';

// Day index in a leap-year calendar (Feb 29 = index 59).
function dayIndex(date) {
  const d = new Date(Date.UTC(2000, date.getUTCMonth(), date.getUTCDate()));
  return Math.round((d - Date.UTC(2000, 0, 1)) / 86400000);
}

/** Climatological stats for a series key ('u60n', 'u60s', 'tcapn', 'tcaps') on a date. */
export function climFor(key, date) {
  if (!clim?.[key]) return null;
  return clim[key][dayIndex(date)];
}

/** Percentile rank (0–100) of a value against the stored quantiles for that date. */
export function percentile(key, date, value) {
  const c = climFor(key, date);
  if (!c) return null;
  const qs = clim.percentiles, p = c.p;
  if (value <= p[0]) return 0;
  if (value >= p[p.length - 1]) return 100;
  for (let i = 0; i < p.length - 1; i++) {
    if (value <= p[i + 1]) {
      const f = (value - p[i]) / ((p[i + 1] - p[i]) || 1);
      return qs[i] + f * (qs[i + 1] - qs[i]);
    }
  }
  return 100;
}

export function percentileText(pct) {
  if (pct == null) return '';
  if (pct <= 0) return 'record low for the date';
  if (pct >= 100) return 'record high for the date';
  const n = Math.round(pct);
  const sfx = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${sfx} percentile`;
}
