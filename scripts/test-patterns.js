// The testing gate for the pattern library. Reads the per-ticker history
// written by scripts/backfill-pattern-events.js and, for every
// (event x asset class x horizon), asks: after this event, did the ticker
// beat its benchmark (SPY / BTC) more or less often than on a typical day?
//
// A pattern is VALIDATED only if all of these hold:
//   1. Discovery (<= DISCOVERY_LAST_YEAR): significant after the
//      Benjamini-Hochberg correction across every pattern tested (q < 0.05).
//   2. Holdout (later years, never used to pick patterns): same direction,
//      p < 0.05 on its own.
//   3. At least MIN_PATTERN_N cases and MIN_DATES different days in each half,
//      and a gap of at least MIN_EFFECT_PTS from the base rate in each half.
// Everything else is recorded as rejected: kept in the registry, not deleted.
//
// Significance is tested per DAY, not per case: on a crash day 200 stocks fire
// "fell 5%" together and move together, so counting them as 200 independent
// cases would overstate the evidence. Each day contributes one number
// (that day's hit rate minus the base rate), tested with pairedDifferenceTest.
//
// Usage: node scripts/test-patterns.js [--dir=data/pattern-cache] [--write]
//   --write  regenerate lib/pattern-registry.js (review before committing).

import fs from 'node:fs';
import path from 'node:path';
import { pairedDifferenceTest } from '../lib/stats.js';
import {
  EVENT_TYPES, EVENT_LABELS, HORIZONS, MIN_PATTERN_N, DISCOVERY_LAST_YEAR,
  PATTERN_VERSION, benjaminiHochberg,
} from '../lib/patterns.js';

const MIN_DATES = 30;
const MIN_EFFECT_PTS = 2;   // percentage points of hit rate vs base rate

function arg(name, fallback) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : fallback;
}
const dir = arg('dir', 'data/pattern-cache');
const write = process.argv.includes('--write');

const half = date => (Number(date.slice(0, 4)) <= DISCOVERY_LAST_YEAR ? 'discovery' : 'holdout');

// ── load ──────────────────────────────────────────────────────────────────
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
if (!files.length) { console.error(`No history in ${dir}. Run scripts/backfill-pattern-events.js first.`); process.exit(1); }

const base = {};      // `${ac}|${half}|${h}|${year}` -> {n, pos}
const buckets = {};   // `${event}|${ac}|${h}|${half}` -> { byDate: Map(date -> {n,pos}), sumAlpha, n, pos }
const years = { stock: {}, crypto: {} };
let tickers = { stock: 0, crypto: 0 };

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (d.version !== PATTERN_VERSION) continue;
  const ac = d.assetClass;
  tickers[ac]++;
  for (const [key, v] of Object.entries(d.base)) {
    const [year, h] = key.split('|');
    const k = `${ac}|${h}|${year}`;
    const slot = base[k] || (base[k] = { n: 0, pos: 0 });
    slot.n += v.n; slot.pos += v.pos;
    years[ac][year] = true;
  }
  for (const row of d.events) {
    const hv = half(row.d);
    for (const h of HORIZONS) {
      const alpha = row.a[h];
      if (alpha == null) continue;
      for (const e of row.e) {
        const k = `${e}|${ac}|${h}|${hv}`;
        const b = buckets[k] || (buckets[k] = { byDate: new Map(), sumAlpha: 0, n: 0, pos: 0 });
        const day = b.byDate.get(row.d) || { n: 0, pos: 0 };
        day.n++; if (alpha > 0) day.pos++;
        b.byDate.set(row.d, day);
        b.n++; if (alpha > 0) b.pos++; b.sumAlpha += alpha;
      }
    }
  }
}

function baseRate(ac, h, yearFilter) {
  let n = 0, pos = 0;
  for (const [k, v] of Object.entries(base)) {
    const [a, hh, year] = k.split('|');
    if (a === ac && Number(hh) === h && yearFilter(Number(year))) { n += v.n; pos += v.pos; }
  }
  return n ? pos / n : null;
}
// Base rate per year, so a day is compared with a typical day of the same year.
function yearBase(ac, h, year) {
  const v = base[`${ac}|${h}|${year}`];
  return v && v.n ? v.pos / v.n : null;
}

function stats(ac, h, b, yearFilter) {
  if (!b) return null;
  const diffs = [];
  for (const [date, day] of b.byDate) {
    const yb = yearBase(ac, h, Number(date.slice(0, 4)));
    if (yb != null) diffs.push(day.pos / day.n - yb);
  }
  const test = pairedDifferenceTest(diffs);
  const yrs = Object.keys(years[ac]).map(Number).filter(yearFilter).sort();
  return {
    n: b.n, dates: b.byDate.size,
    hitRate: b.pos / b.n, baseRate: baseRate(ac, h, yearFilter),
    meanAlpha: b.sumAlpha / b.n,
    p: test ? test.pValue : 1,
    years: yrs.length ? `${yrs[0]}-${yrs.at(-1)}` : '',
  };
}

// ── test ──────────────────────────────────────────────────────────────────
const isDisc = y => y <= DISCOVERY_LAST_YEAR, isHold = y => y > DISCOVERY_LAST_YEAR;
const results = [];
for (const ac of ['stock', 'crypto']) {
  if (!tickers[ac]) continue;
  for (const event of EVENT_TYPES) for (const h of HORIZONS) {
    const d = stats(ac, h, buckets[`${event}|${ac}|${h}|discovery`], isDisc);
    const o = stats(ac, h, buckets[`${event}|${ac}|${h}|holdout`], isHold);
    if (!d) continue;
    results.push({ event, assetClass: ac, horizon: h, discovery: d, holdout: o });
  }
}

const q = benjaminiHochberg(results.map(r => r.discovery.p));
results.forEach((r, i) => { r.discovery.q = q[i]; });

for (const r of results) {
  const d = r.discovery, o = r.holdout;
  const lean = d.hitRate >= d.baseRate ? 'higher' : 'lower';
  const effect = x => Math.abs(x.hitRate - x.baseRate) * 100;
  const sameDir = o && (o.hitRate >= o.baseRate ? 'higher' : 'lower') === lean;
  const reasons = [];
  if (d.n < MIN_PATTERN_N || d.dates < MIN_DATES) reasons.push('too few discovery cases');
  if (d.q >= 0.05) reasons.push('not significant in discovery after correction');
  if (effect(d) < MIN_EFFECT_PTS) reasons.push('discovery effect too small');
  if (!o || o.n < MIN_PATTERN_N || o.dates < MIN_DATES) reasons.push('too few holdout cases');
  else {
    if (!sameDir) reasons.push('flipped direction in holdout');
    else if (o.p >= 0.05) reasons.push('not significant in holdout');
    if (effect(o) < MIN_EFFECT_PTS) reasons.push('holdout effect too small');
  }
  r.lean = lean;
  r.status = reasons.length ? 'rejected' : 'validated';
  r.reasons = reasons;
}

// ── report ────────────────────────────────────────────────────────────────
const pct = x => (x * 100).toFixed(1).padStart(5);
console.log(`\nPattern gate (${PATTERN_VERSION}): ${tickers.stock} stocks, ${tickers.crypto} coins, ${results.length} patterns tested`);
console.log(`Discovery: ${DISCOVERY_LAST_YEAR} and earlier. Holdout: ${DISCOVERY_LAST_YEAR + 1} onward. "hit" = beat SPY/BTC over the horizon.`);
console.log('Caveat: stocks are TODAY\'s S&P 500 members, so companies that dropped out of the index are missing (survivorship bias).\n');
console.log('status     class   h   event                         disc hit  base   n      days   q       | hold hit  base   n      p');
for (const r of [...results].sort((a, b) => (a.status === b.status ? 0 : a.status === 'validated' ? -1 : 1))) {
  const d = r.discovery, o = r.holdout;
  console.log(`${r.status.padEnd(10)} ${r.assetClass.padEnd(7)} ${String(r.horizon).padStart(2)}  ${r.event.padEnd(28)} `
    + `${pct(d.hitRate)}%  ${pct(d.baseRate)}% ${String(d.n).padStart(6)} ${String(d.dates).padStart(5)}  ${d.q.toFixed(4)}  | `
    + (o ? `${pct(o.hitRate)}%  ${pct(o.baseRate)}% ${String(o.n).padStart(6)}  ${o.p.toFixed(4)}` : 'no holdout data')
    + (r.status === 'rejected' ? `   (${r.reasons[0]})` : ''));
}
const validated = results.filter(r => r.status === 'validated');
console.log(`\n${validated.length} validated, ${results.length - validated.length} rejected.`);
for (const v of validated) {
  console.log(`  ${v.assetClass} ${EVENT_LABELS[v.event]} -> beat benchmark over ${v.horizon} bars ${v.lean} than usual `
    + `(${pct(v.discovery.hitRate).trim()}% vs ${pct(v.discovery.baseRate).trim()}%, holdout ${pct(v.holdout.hitRate).trim()}% vs ${pct(v.holdout.baseRate).trim()}%)`);
}

// ── write registry ────────────────────────────────────────────────────────
if (write) {
  const round = s => s && ({ ...s, hitRate: +s.hitRate.toFixed(4), baseRate: +s.baseRate.toFixed(4),
    meanAlpha: +s.meanAlpha.toFixed(3), p: +s.p.toPrecision(3), ...(s.q != null ? { q: +s.q.toPrecision(3) } : {}) });
  const entries = results.map(r => ({
    event: r.event, assetClass: r.assetClass, horizon: r.horizon, lean: r.lean, status: r.status,
    ...(r.reasons.length ? { reasons: r.reasons } : {}),
    discovery: round(r.discovery), holdout: round(r.holdout),
  }));
  const out = `// GENERATED by scripts/test-patterns.js on ${new Date().toISOString().slice(0, 10)}. Do not hand-edit numbers.
// ${tickers.stock} stocks + ${tickers.crypto} coins; discovery <= ${DISCOVERY_LAST_YEAR}, holdout after.
// Only status 'validated' entries can reach the analysis prompt, and only once
// PATTERNS_REVIEWED is true (flip it by hand after a person has read this list).

export const PATTERN_REGISTRY_VERSION = '${PATTERN_VERSION}';
export const PATTERNS_REVIEWED = false;

export const PATTERN_REGISTRY = ${JSON.stringify(entries, null, 2)};
`;
  fs.writeFileSync('lib/pattern-registry.js', out);
  console.log('\nWrote lib/pattern-registry.js');
}
