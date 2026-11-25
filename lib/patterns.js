/**
 * Pattern library: price/volume "events" (a 5% drop, a volume spike, a new
 * 52-week high, ...) and what tended to happen after them.
 *
 * The same pure functions run in three places, so a pattern means exactly the
 * same thing everywhere:
 *   - scripts/backfill-pattern-events.js: years of daily history -> event rows
 *   - scripts/test-patterns.js: tests each pattern on 2018-2023, re-tests it
 *     on 2024 onward, and writes lib/pattern-registry.js
 *   - lib/quant-signals.js (live): which events fired on the latest bar
 *
 * No look-ahead: every event at day i uses only closes/volumes at indexes <= i.
 * Forward returns are measured from the close of day i.
 */

export const PATTERN_VERSION = 'patterns-v1';
export const HORIZONS = [1, 5, 20];          // trading days (calendar days for crypto)
export const REFRACTORY_DAYS = 5;            // the same event can't re-fire within 5 bars
export const MIN_PATTERN_N = 30;             // below this a pattern says "not enough data"
export const DISCOVERY_LAST_YEAR = 2023;     // discovery <= 2023, holdout >= 2024

// Plain-English labels, used by the prompt and the test report.
export const EVENT_LABELS = {
  up_3_5:         'rose 3-5% in a day',
  up_5plus:       'rose 5% or more in a day',
  down_3_5:       'fell 3-5% in a day',
  down_5plus:     'fell 5% or more in a day',
  volume_2x:      'traded at 2x or more its 20-day average volume',
  high_52w:       'closed at a new 52-week high',
  low_52w:        'closed at a new 52-week low',
  rsi_oversold:   'RSI(14) dropped below 30',
  rsi_overbought: 'RSI(14) rose above 70',
  drawdown_20:    'fell 20% or more below its 52-week high',
  streak_up_3:    'closed higher 3 days in a row',
  streak_down_3:  'closed lower 3 days in a row',
};
export const EVENT_TYPES = Object.keys(EVENT_LABELS);

// A year of bars: 252 trading days for stocks, 365 days for crypto (trades daily).
export function yearBars(assetClass) {
  return assetClass === 'crypto' ? 365 : 252;
}

// Simple-average RSI(14) at index i, same formula as lib/quant-signals.js.
export function rsi14At(closes, i) {
  if (i < 14) return null;
  let gains = 0, losses = 0;
  for (let k = i - 13; k <= i; k++) {
    const diff = closes[k] - closes[k - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / 14) / (losses / 14);
  return 100 - 100 / (1 + rs);
}

function _maxRange(arr, from, to) {   // inclusive
  let m = -Infinity;
  for (let k = Math.max(0, from); k <= to; k++) if (arr[k] > m) m = arr[k];
  return m;
}
function _minRange(arr, from, to) {
  let m = Infinity;
  for (let k = Math.max(0, from); k <= to; k++) if (arr[k] < m) m = arr[k];
  return m;
}

// Events whose definition is true at bar i, before the refractory filter.
// "Crossing" definitions (RSI, drawdown, streak) fire on the bar the condition
// first becomes true, not on every bar it stays true.
function _rawEventsAt(closes, volumes, i, lookback) {
  const out = [];
  if (i < 1) return out;
  const ret = (closes[i] / closes[i - 1] - 1) * 100;
  if (ret >= 5) out.push('up_5plus');
  else if (ret >= 3) out.push('up_3_5');
  if (ret <= -5) out.push('down_5plus');
  else if (ret <= -3) out.push('down_3_5');

  if (volumes && i >= 20 && volumes[i] > 0) {
    let sum = 0, cnt = 0;
    for (let k = i - 20; k < i; k++) if (volumes[k] > 0) { sum += volumes[k]; cnt++; }
    if (cnt >= 15 && volumes[i] >= 2 * (sum / cnt)) out.push('volume_2x');
  }

  if (i >= lookback) {
    const prevMax = _maxRange(closes, i - lookback, i - 1);
    const prevMin = _minRange(closes, i - lookback, i - 1);
    if (closes[i] > prevMax) out.push('high_52w');
    if (closes[i] < prevMin) out.push('low_52w');
    const ddNow  = closes[i] / _maxRange(closes, i - lookback, i);
    const ddPrev = closes[i - 1] / _maxRange(closes, i - 1 - lookback, i - 1);
    if (ddNow <= 0.8 && ddPrev > 0.8) out.push('drawdown_20');
  }

  const rsiNow = rsi14At(closes, i), rsiPrev = rsi14At(closes, i - 1);
  if (rsiNow != null && rsiPrev != null) {
    if (rsiNow < 30 && rsiPrev >= 30) out.push('rsi_oversold');
    if (rsiNow > 70 && rsiPrev <= 70) out.push('rsi_overbought');
  }

  if (i >= 4) {
    const up = k => closes[k] > closes[k - 1];
    const dn = k => closes[k] < closes[k - 1];
    if (up(i) && up(i - 1) && up(i - 2) && !up(i - 3)) out.push('streak_up_3');
    if (dn(i) && dn(i - 1) && dn(i - 2) && !dn(i - 3)) out.push('streak_down_3');
  }
  return out;
}

/**
 * Events at every bar, after the refractory filter (an event that fired in the
 * previous REFRACTORY_DAYS bars doesn't fire again, so one episode isn't
 * counted five times). Returns an array the same length as `closes`.
 */
export function detectEvents(closes, volumes, { assetClass = 'stock' } = {}) {
  const lookback = yearBars(assetClass);
  const lastFired = {};
  const result = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    const fired = [];
    for (const e of _rawEventsAt(closes, volumes, i, lookback)) {
      if (lastFired[e] != null && i - lastFired[e] <= REFRACTORY_DAYS) continue;
      lastFired[e] = i;
      fired.push(e);
    }
    result[i] = fired;
  }
  return result;
}

// Events on the most recent bar, for a live call.
export function eventsOnLastBar(closes, volumes, opts) {
  if (!closes?.length) return [];
  return detectEvents(closes, volumes, opts).at(-1);
}

export function forwardReturnPct(closes, i, h) {
  const j = i + h;
  if (j >= closes.length || !(closes[i] > 0) || !(closes[j] > 0)) return null;
  return (closes[j] / closes[i] - 1) * 100;
}

// Drops bars with a missing close and keeps closes/volumes/dates aligned.
export function cleanSeries({ timestamps = [], closes = [], volumes = [] }) {
  const out = { dates: [], closes: [], volumes: [] };
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] == null || !(closes[i] > 0) || timestamps[i] == null) continue;
    out.dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
    out.closes.push(closes[i]);
    out.volumes.push(volumes[i] ?? null);
  }
  return out;
}

/**
 * Turns one ticker's cleaned history into
 *   events: [{ d: 'YYYY-MM-DD', e: ['down_5plus', ...], a: {1: alpha%, 5: ..., 20: ...} }]
 *   base:   { '<year>|<h>': { n, pos } }   - every bar, for the base rate
 * Alpha = ticker forward return minus the benchmark's over the same dates.
 * `benchByDate` maps date -> benchmark close; pass null to use raw returns.
 */
export function buildEventRows({ dates, closes, volumes }, benchByDate, { assetClass = 'stock' } = {}) {
  const events = [];
  const base = {};
  const perBar = detectEvents(closes, volumes, { assetClass });
  for (let i = 0; i < closes.length; i++) {
    const a = {};
    for (const h of HORIZONS) {
      const raw = forwardReturnPct(closes, i, h);
      if (raw == null) continue;
      let alpha = raw;
      if (benchByDate) {
        const b0 = benchByDate.get(dates[i]), b1 = benchByDate.get(dates[i + h]);
        if (!(b0 > 0) || !(b1 > 0)) continue;
        alpha = raw - (b1 / b0 - 1) * 100;
      }
      a[h] = +alpha.toFixed(3);
      const key = `${dates[i].slice(0, 4)}|${h}`;
      const slot = base[key] || (base[key] = { n: 0, pos: 0 });
      slot.n++;
      if (alpha > 0) slot.pos++;
    }
    if (perBar[i].length && Object.keys(a).length) events.push({ d: dates[i], e: perBar[i], a });
  }
  return { events, base };
}

/**
 * Benjamini-Hochberg: given p-values, returns q-values (adjusted p) in the
 * same order. Used because the gate tests dozens of patterns at once.
 */
export function benjaminiHochberg(pValues) {
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const q = new Array(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, idx] = order[r];
    running = Math.min(running, (p * m) / (r + 1));
    q[idx] = running;
  }
  return q;
}

/**
 * Validated registry entries that apply to the events firing now.
 * `registry` is PATTERN_REGISTRY from lib/pattern-registry.js.
 */
export function matchValidatedPatterns(events, assetClass, registry) {
  if (!events?.length || !registry?.length) return [];
  return registry.filter(p => p.status === 'validated'
    && p.assetClass === assetClass && events.includes(p.event));
}

function _pct(x) { return `${Math.round(x * 100)}%`; }

// One plain-English line per matched pattern, for the prompt.
export function describePattern(p, ticker) {
  const bench = p.assetClass === 'crypto' ? 'BTC' : 'SPY';
  const span = p.horizon === 1 ? 'the next day' : `the next ${p.horizon} ${p.assetClass === 'crypto' ? 'days' : 'trading days'}`;
  const d = p.discovery, h = p.holdout;
  return `- $${ticker} ${EVENT_LABELS[p.event]} on the latest bar. In ${d.n.toLocaleString('en-US')} past cases (${d.dates} different days, ${d.years}), `
    + `${p.assetClass === 'crypto' ? 'coins' : 'stocks'} beat ${bench} over ${span} ${_pct(d.hitRate)} of the time vs ${_pct(d.baseRate)} on a typical day `
    + `(average ${d.meanAlpha > 0 ? '+' : ''}${d.meanAlpha.toFixed(2)} pts vs ${bench}). `
    + `It held up on later data it wasn't found on (${h.years}: ${_pct(h.hitRate)} vs ${_pct(h.baseRate)}, ${h.n.toLocaleString('en-US')} cases).`;
}
