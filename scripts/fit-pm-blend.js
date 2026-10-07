// Read-only: does Claude's BLIND probability (made without seeing the
// market's odds — see PM_BLIND_VERSION in api/market-analyze.js) add anything
// on top of the crowd? Fits P(YES) = sigmoid(a + b·logit(market) + c·logit(blind))
// on earlier markets, then scores it on later ones it never saw, next to the
// crowd alone, the shown (crowd-anchored) model, and the blind model alone.
//
// Uses every market that got a blind estimate — graded calls AND close calls
// saved as pm_briefings — so the sample isn't only the markets Claude felt
// sure about. Outcomes come from Polymarket directly (same oracle check the
// grader uses, lib/pm-resolution.js), so briefings, which are never graded,
// still count. Nothing is written anywhere.
//
// Usage: node scripts/fit-pm-blend.js [--split=0.7] [--since=2026-10-08]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { pickPmMarket, pmOutcome } from '../lib/pm-resolution.js';
import { logit, brier, logLoss, fitLogistic, predictLogistic, bootstrapBrierDiff } from '../lib/pm-blend.js';

const MIN_TEST = 50;   // below this, print results but say they're noise
const CONCURRENCY = 6;

function arg(name, fallback) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : fallback;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

async function fetchAll(supabase, table, since) {
  const out = [];
  for (let from = 0; from < 50000; from += 1000) {
    let q = supabase.from(table)
      .select('id, created_at, topic, market_slug, market_odds_at_time, model_probability, analysis' + (table === 'predictions' ? ', lean, correct' : ''))
      .not('analysis->blind', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function fetchEvent(slug) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const events = await r.json();
    return (Array.isArray(events) ? events[0] : events) || null;
  } catch (_) { return null; }
}

// 'Yes' | 'No' | null. Graded calls already know; everything else asks the oracle.
async function resolveOutcomes(rows) {
  const eventBySlug = new Map();
  const slugs = [...new Set(rows.filter(r => !r._known && r.market_slug).map(r => r.market_slug))];
  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < slugs.length) {
      const slug = slugs[idx++];
      eventBySlug.set(slug, await fetchEvent(slug));
    }
  }));
  for (const r of rows) {
    if (r._known) { r.outcome = r._known; continue; }
    const ev = r.market_slug ? eventBySlug.get(r.market_slug) : null;
    r.outcome = ev ? pmOutcome(pickPmMarket(ev, r.topic)) : null;
  }
}

const f4 = x => (x == null ? '   —  ' : x.toFixed(4));
const pct = (n, d) => (d ? `${Math.round(n / d * 100)}%` : '—');

function scoreLine(label, probs, ys) {
  return `  ${label.padEnd(26)} Brier ${f4(brier(probs, ys))}   log loss ${f4(logLoss(probs, ys))}`;
}

async function main() {
  const supabase = getSupabase();
  const split = Math.min(0.95, Math.max(0.3, parseFloat(arg('split', '0.7'))));
  const since = arg('since', null);

  const [preds, briefs] = await Promise.all([
    fetchAll(supabase, 'predictions', since),
    fetchAll(supabase, 'pm_briefings', since),
  ]);
  const rows = [
    ...preds.map(p => ({
      ...p, kind: 'call',
      _known: p.correct == null ? null
        : (p.analysis?.resolved_outcome || (p.correct ? p.lean : (p.lean === 'Yes' ? 'No' : 'Yes'))),
    })),
    ...briefs.map(b => ({ ...b, kind: 'briefing', _known: null })),
  ].filter(r => r.market_odds_at_time != null && typeof r.analysis?.blind?.probability === 'number');

  console.log(`Rows with a blind estimate: ${rows.length} (${preds.length} calls, ${briefs.length} briefings)`);
  if (!rows.length) {
    console.log('Nothing to fit yet — blind estimates start with pm-blind-v1. Rerun once some of those markets resolve.');
    return;
  }

  await resolveOutcomes(rows);
  const resolved = rows.filter(r => r.outcome === 'Yes' || r.outcome === 'No');
  const shownProb = r => (typeof r.model_probability === 'number' ? r.model_probability : r.analysis?.yes_probability);
  for (const r of resolved) {
    r.y = r.outcome === 'Yes' ? 1 : 0;
    r.market = r.market_odds_at_time;
    r.blind = r.analysis.blind.probability;
    r.shown = typeof shownProb(r) === 'number' ? shownProb(r) : null;
  }
  console.log(`Resolved so far: ${resolved.length} (${resolved.filter(r => r.kind === 'call').length} calls, ${resolved.filter(r => r.kind === 'briefing').length} briefings)\n`);
  if (resolved.length < 10) {
    console.log('Too few resolved markets to say anything yet.');
    return;
  }

  // Time split by MARKET, not by row: the same market is often analyzed on
  // several days, and letting one copy train and another test would leak.
  const firstSeen = new Map();
  for (const r of resolved) {
    const key = r.market_slug ? `${r.market_slug}::${r.topic}` : r.topic;
    r._key = key;
    if (!firstSeen.has(key) || r.created_at < firstSeen.get(key)) firstSeen.set(key, r.created_at);
  }
  const markets = [...firstSeen.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(e => e[0]);
  const trainKeys = new Set(markets.slice(0, Math.floor(markets.length * split)));
  const train = resolved.filter(r => trainKeys.has(r._key));
  const test = resolved.filter(r => !trainKeys.has(r._key));
  console.log(`Split: ${trainKeys.size} markets / ${train.length} rows to fit, ${markets.length - trainKeys.size} later markets / ${test.length} rows to test`);

  const feats = r => [logit(r.market), logit(r.blind)];
  const w = fitLogistic(train.map(feats), train.map(r => r.y));
  const wAll = fitLogistic(resolved.map(feats), resolved.map(r => r.y));
  console.log(`\nBlend weights (fit on the earlier markets): intercept ${w[0].toFixed(3)}, crowd ${w[1].toFixed(3)}, blind AI ${w[2].toFixed(3)}`);
  console.log(`Blend weights (fit on everything, for reference): intercept ${wAll[0].toFixed(3)}, crowd ${wAll[1].toFixed(3)}, blind AI ${wAll[2].toFixed(3)}`);
  console.log('  Blind AI weight near 0 = it adds nothing the crowd did not already know. Clearly above 0 = real added information.');

  const evalSet = test.length ? test : resolved;
  const ys = evalSet.map(r => r.y);
  const crowd = evalSet.map(r => r.market);
  const blind = evalSet.map(r => r.blind);
  const blend = evalSet.map(r => predictLogistic(w, feats(r)));
  console.log(`\nScored on ${test.length ? 'the later markets only' : 'ALL rows (no held-out markets yet, so this flatters the blend)'} (n=${evalSet.length}, lower is better):`);
  console.log(scoreLine('Crowd (market odds)', crowd, ys));
  const withShown = evalSet.filter(r => r.shown != null);
  if (withShown.length) {
    console.log(scoreLine(`Shown AI (sees odds) n=${withShown.length}`, withShown.map(r => r.shown), withShown.map(r => r.y)));
  }
  console.log(scoreLine('Blind AI', blind, ys));
  console.log(scoreLine('Blend', blend, ys));

  const ciBlind = bootstrapBrierDiff(blind, crowd, ys);
  const ciBlend = bootstrapBrierDiff(blend, crowd, ys);
  const verdict = ci => (ci.upper < 0 ? 'better than the crowd' : ci.lower > 0 ? 'worse than the crowd' : 'not distinguishable from the crowd yet');
  console.log(`\nBrier vs crowd, 95% interval (negative = better than the crowd):`);
  console.log(`  Blind AI  ${ciBlind.lower.toFixed(4)} to ${ciBlind.upper.toFixed(4)}  → ${verdict(ciBlind)}`);
  console.log(`  Blend     ${ciBlend.lower.toFixed(4)} to ${ciBlend.upper.toFixed(4)}  → ${verdict(ciBlend)}`);

  // Where the blind AI and the crowd pick different sides — the only place
  // being right means anything beyond "agreed with the favorite".
  const disagree = evalSet.filter(r => r.market !== 50 && r.blind !== 50 && (r.market > 50) !== (r.blind > 50));
  const blindRight = disagree.filter(r => (r.blind > 50 ? 1 : 0) === r.y).length;
  console.log(`\nBlind AI disagreed with the crowd's favorite on ${disagree.length} of ${evalSet.length} (${pct(disagree.length, evalSet.length)})`);
  console.log(`  …and was right on ${blindRight} of those (${pct(blindRight, disagree.length)}). The crowd was right on the rest.`);

  if (evalSet.length < MIN_TEST) {
    console.log(`\nNOTE: only ${evalSet.length} scored rows (want ${MIN_TEST}+, ideally a few hundred). Treat everything above as noise for now.`);
  }
  console.log('NOTE: rows from the same market on different days are not independent, so intervals are somewhat optimistic.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
