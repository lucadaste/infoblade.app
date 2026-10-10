// One-time cleanup: re-grades resolved predictions that were caught by the
// weekend/1-day grading gap fixed in api/generate-baseline.js
// (_stockOneDayHorizonIsSafe). Those predictions were resolved before any
// real new trading-day price existed, so baseline price == actual price for
// every single ticker (a flat 0% move), which always grades as incorrect
// regardless of what was actually predicted — not a real signal, a data gap.
//
// Signature used to find affected rows: EVERY ticker in the prediction shows
// exactly 0% raw move. Real market data essentially never does that across
// multiple distinct tickers on distinct dates, so this is a safe, specific
// fingerprint — not a heuristic that could accidentally catch genuinely
// flat/correct predictions.
//
// Since real time has now passed since these were originally (prematurely)
// resolved, a fresh price-history fetch today has real trading-day data to
// compare against, so this just re-runs the exact same resolution logic
// (mirrored from api/predictions.js's handleResolve/_fetchTickerHistory/
// _priceOnDate — kept as a deliberate one-time copy here, not a shared
// import, since this script is meant to be run once and retired) with
// current data instead of the stale snapshot that existed at original
// resolution time.
//
// Dry-run by default — prints what WOULD change. Pass --write to actually
// update the database.
//
// Usage: node scripts/regrade-weekend-gap-predictions.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { computeAccuracyScore, SCORING_VERSION } from '../lib/scoring.js';
import { benchmarkFor, ALL_BENCHMARKS } from '../lib/benchmarks.js';
import { COIN_SYMS, yahooSymbol } from '../lib/coin-symbols.js';

const WRITE = process.argv.includes('--write');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

// Mirrors api/predictions.js's _fetchTickerHistory exactly.
async function fetchTickerHistory(ticker, startMs, endMs) {
  const p1 = Math.floor(startMs / 1000) - 7 * 86400;
  const p2 = Math.floor(endMs   / 1000) + 7 * 86400;
  const yTicker = yahooSymbol(ticker);
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?interval=1d&period1=${p1}&period2=${p2}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return {};
    const tss = result.timestamp || result.timestamps || [];
    const closes = result.indicators?.adjclose?.[0]?.adjclose
                || result.indicators?.quote?.[0]?.close || [];
    const map = {};
    for (let i = 0; i < tss.length; i++) {
      if (closes[i] == null) continue;
      map[new Date(tss[i] * 1000).toISOString().slice(0, 10)] = +closes[i].toFixed(4);
    }
    return map;
  } catch (_) { return {}; }
}

// Mirrors api/predictions.js's _priceOnDate exactly.
function priceOnDate(historyMap, targetDate) {
  const keys = Object.keys(historyMap);
  if (!keys.length) return null;
  const targetMs = targetDate.getTime();
  let best = null, bestDiff = Infinity;
  for (const k of keys) {
    const diff = Math.abs(new Date(k).getTime() - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = k; }
  }
  return bestDiff <= 7 * 86400000 ? historyMap[best] : null;
}

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('predictions')
    .select('id, category, created_at, validation_date, winner_tickers, loser_tickers, baseline_prices, analysis, correct')
    .not('correct', 'is', null)
    .not('winner_tickers', 'is', null)
    .limit(3000);
  if (error) throw error;

  // Find the exact-zero-everywhere signature.
  const affected = (data || []).filter(p => {
    const moves = p.analysis?.ticker_moves;
    if (!moves) return false;
    const values = Object.values(moves);
    if (!values.length) return false;
    return values.every(m => m.pct === 0);
  });

  console.log(`Scanned ${data.length} resolved predictions. Found ${affected.length} matching the weekend-gap signature (every ticker at exactly 0%).\n`);
  if (!affected.length) { console.log('Nothing to fix.'); return; }

  // Batch-fetch fresh history for every unique ticker involved, same pattern as handleResolve.
  const uniqueTickers = new Set(ALL_BENCHMARKS);
  let minMs = Date.now(), maxMs = 0;
  for (const p of affected) {
    for (const t of [...(p.winner_tickers || []), ...(p.loser_tickers || [])]) uniqueTickers.add(t);
    const createdMs = new Date(p.created_at).getTime();
    const vMs = new Date(p.validation_date).getTime();
    if (createdMs < minMs) minMs = createdMs;
    if (vMs > maxMs) maxMs = vMs;
  }
  // Extend maxMs to "now" — the whole point is fresh data has since become available.
  maxMs = Math.max(maxMs, Date.now());

  const histories = {};
  const tickerList = [...uniqueTickers];
  for (let i = 0; i < tickerList.length; i += 5) {
    const chunk = tickerList.slice(i, i + 5);
    await Promise.all(chunk.map(async t => { histories[t] = await fetchTickerHistory(t, minMs, maxMs); }));
    if (i + 5 < tickerList.length) await new Promise(r => setTimeout(r, 300));
  }

  let stillZero = 0, nowFixed = 0, flippedCorrect = 0, flippedIncorrect = 0, stillNoData = 0;
  const updates = [];

  for (const pred of affected) {
    const winners = (pred.winner_tickers || []).filter(t => histories[t] && Object.keys(histories[t]).length);
    const losers  = (pred.loser_tickers  || []).filter(t => histories[t] && Object.keys(histories[t]).length);
    if (!winners.length && !losers.length) { stillNoData++; continue; }

    const createdDate = new Date(pred.created_at);
    const valDate = new Date(pred.validation_date);

    const baseline = { ...(pred.baseline_prices || {}) };
    for (const t of [...winners, ...losers]) {
      if (!baseline[t]) {
        const p = priceOnDate(histories[t], createdDate);
        if (p != null) baseline[t] = p;
      }
    }
    const actual = {};
    for (const t of [...winners, ...losers]) {
      const p = priceOnDate(histories[t], valDate);
      if (p != null) actual[t] = p;
    }

    const benchCache = {};
    function benchmarkPctFor(benchTicker) {
      if (!benchTicker || !histories[benchTicker]) return null;
      if (benchTicker in benchCache) return benchCache[benchTicker];
      const bBase = priceOnDate(histories[benchTicker], createdDate);
      const bAct  = priceOnDate(histories[benchTicker], valDate);
      const result = (bBase != null && bAct != null) ? (bAct - bBase) / bBase * 100 : null;
      benchCache[benchTicker] = result;
      return result;
    }

    const rawMoves = {};
    for (const t of winners) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const benchPct = benchmarkPctFor(benchmarkFor(t, COIN_SYMS.has(t)));
      const alphaPct = benchPct != null ? +(pct - benchPct).toFixed(2) : undefined;
      rawMoves[t] = { pct, alphaPct, direction: 'bullish', basePrice: baseline[t], actualPrice: actual[t] };
    }
    for (const t of losers) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const benchPct = benchmarkPctFor(benchmarkFor(t, COIN_SYMS.has(t)));
      const alphaPct = benchPct != null ? +(pct - benchPct).toFixed(2) : undefined;
      rawMoves[t] = { pct, alphaPct, direction: 'bearish', basePrice: baseline[t], actualPrice: actual[t] };
    }

    const result = computeAccuracyScore(rawMoves);
    if (!result) { stillNoData++; continue; }

    const allStillZero = Object.values(result.tickerMoves).every(m => m.pct === 0);
    if (allStillZero) { stillZero++; continue; }

    nowFixed++;
    if (result.correct && !pred.correct) flippedCorrect++;
    if (!result.correct && pred.correct) flippedIncorrect++; // shouldn't happen (old was always false) but track it

    console.log(`  ${pred.id} (${pred.category}): was correct=${pred.correct} -> now correct=${result.correct} :: ${Object.entries(result.tickerMoves).map(([t,m]) => `${t} ${m.pct}%`).join(', ')}`);

    updates.push({
      id: pred.id,
      correct: result.correct,
      actual_prices: actual,
      analysis: {
        ...(pred.analysis || {}),
        grade: result.grade, score: result.accuracyScore, accuracy_score: result.accuracyScore, outcome: result.outcome,
        raw_accuracy_score: result.rawAccuracyScore, raw_correct: result.rawCorrect, raw_grade: result.rawGrade,
        scoring_version: SCORING_VERSION, ticker_moves: result.tickerMoves,
        regraded_note: 'Re-graded by scripts/regrade-weekend-gap-predictions.js — original resolution hit the weekend 1-day grading gap (see api/generate-baseline.js fix).',
      },
    });
  }

  console.log(`\nSummary:`);
  console.log(`  Still no usable data (skipped): ${stillNoData}`);
  console.log(`  Still all-zero even with fresh data (genuinely no movement yet, skipped): ${stillZero}`);
  console.log(`  Now have real data, re-graded: ${nowFixed}`);
  console.log(`    -> flipped incorrect to correct: ${flippedCorrect}`);
  console.log(`    -> flipped correct to incorrect: ${flippedIncorrect}`);
  console.log(`    -> stayed incorrect (real data, still wrong direction): ${nowFixed - flippedCorrect - flippedIncorrect}`);

  if (!WRITE) {
    console.log(`\nDry run only — pass --write to apply these ${updates.length} updates to the database.`);
    return;
  }

  console.log(`\nWriting ${updates.length} updates...`);
  let written = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase.from('predictions').update({
      correct: u.correct, actual_prices: u.actual_prices, analysis: u.analysis,
    }).eq('id', u.id);
    if (upErr) console.error(`  FAILED ${u.id}:`, upErr.message);
    else written++;
  }
  console.log(`Done. ${written}/${updates.length} rows updated.`);
}

main().catch(err => {
  console.error('[regrade-weekend-gap-predictions] failed:', err.message);
  process.exit(1);
});
