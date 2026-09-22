// Read-only: investigates why the 1-star calibration bucket shows such low
// accuracy. v2 — the first version conflated predictions scored under
// different SCORING_VERSIONs (old rows predate alpha-adjustment entirely,
// so their `ticker_moves` never had alphaPct at all) and didn't account for
// the hitBonus term, making its raw-vs-alpha comparison unreliable. This
// version: (a) splits by scoring_version so only apples-to-apples rows are
// compared, (b) recomputes the real hitBonus-inclusive score instead of a
// naive average, (c) separately checks whether basket size (how many
// tickers got bundled into one prediction) correlates with accuracy — a
// zero-source single-ticker baseline call ("AMD stock outlook") sometimes
// comes back with 5-14 unrelated tickers in winners/losers, which averages
// away the specific call being tested.
//
// Usage: node scripts/diagnose-alpha-mismatch.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { hitRateBonus, tickerScore, classifyScore } from '../lib/scoring.js';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

function parseConfidenceStars(conf) {
  if (!conf) return 3;
  const m = String(conf).match(/^\s*([1-5])/);
  return m ? parseInt(m[1]) : 3;
}

// Recompute what `correct` would be using ONLY the raw (non-alpha) return —
// same hitBonus-inclusive formula the app itself uses, just fed rawPts
// instead of alpha-based pts, so it's a fair like-for-like comparison.
function rawWouldBeCorrect(moves) {
  const pts = moves.map(m => m.rawPts).filter(v => typeof v === 'number');
  if (!pts.length) return null;
  const hitCount = moves.filter(m => typeof m.rawPts === 'number' && Math.abs(m.rawPts) >= 20).length; // rawPts=20 <=> 2% move, matches HIT_THRESHOLD_PCT
  const avg = pts.reduce((a, b) => a + b, 0) / pts.length;
  const bonus = hitRateBonus(hitCount, pts.length);
  return classifyScore(avg + bonus).correct;
}

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('predictions')
    .select('id, category, sources, analysis, correct')
    .not('correct', 'is', null)
    .not('winner_tickers', 'is', null)
    .limit(3000);
  if (error) throw error;

  const rows = (data || []).filter(p => p.analysis?.ticker_moves);
  console.log(`Resolved stock/crypto predictions with ticker_moves: ${rows.length}\n`);

  // ── Split by scoring_version ──────────────────────────────────────────────
  const byVersion = {};
  for (const p of rows) {
    const v = p.analysis?.scoring_version ?? 'unversioned';
    byVersion[v] = (byVersion[v] || 0) + 1;
  }
  console.log('By scoring_version:', byVersion, '\n');

  // ── Focus on the CURRENT version only (apples-to-apples) ──────────────────
  const CURRENT_VERSION = Math.max(...Object.keys(byVersion).filter(v => v !== 'unversioned').map(Number));
  const current = rows.filter(p => p.analysis?.scoring_version === CURRENT_VERSION);
  console.log(`=== Focusing on scoring_version ${CURRENT_VERSION} (n=${current.length}) ===\n`);

  const byStar = {};
  for (const p of current) {
    const star = parseConfidenceStars(p.analysis?.confidence);
    const isZeroSource = !p.sources || p.sources.length === 0;
    const moves = Object.values(p.analysis.ticker_moves);
    const basketSize = moves.length;
    const rawCorrect = rawWouldBeCorrect(moves);

    if (!byStar[star]) byStar[star] = {
      n: 0, alphaCorrect: 0, rawCorrect: 0, rawComparable: 0,
      singleTicker: { n: 0, alphaCorrect: 0 },
      multiTicker:  { n: 0, alphaCorrect: 0 },
      basketSizes: [],
    };
    const b = byStar[star];
    b.n++;
    if (p.correct) b.alphaCorrect++;
    if (rawCorrect != null) { b.rawComparable++; if (rawCorrect) b.rawCorrect++; }
    b.basketSizes.push(basketSize);

    const sizeBucket = basketSize === 1 ? b.singleTicker : b.multiTicker;
    sizeBucket.n++;
    if (p.correct) sizeBucket.alphaCorrect++;
  }

  for (const star of [1, 2, 3, 4, 5]) {
    const b = byStar[star];
    if (!b) { console.log(`${star}-star: no data\n`); continue; }
    const avgBasket = (b.basketSizes.reduce((a, c) => a + c, 0) / b.basketSizes.length).toFixed(1);
    console.log(`=== ${star}-star (n=${b.n}) ===`);
    console.log(`  Official accuracy (alpha-based, what the dashboard shows): ${(b.alphaCorrect / b.n * 100).toFixed(1)}%`);
    console.log(`  Raw-return accuracy (same formula, no alpha adjustment):   ${b.rawComparable ? (b.rawCorrect / b.rawComparable * 100).toFixed(1) : 'n/a'}%`);
    console.log(`  Average basket size (tickers per prediction): ${avgBasket}`);
    console.log(`  Single-ticker predictions (n=${b.singleTicker.n}): ${b.singleTicker.n ? (b.singleTicker.alphaCorrect / b.singleTicker.n * 100).toFixed(1) : 'n/a'}% accuracy`);
    console.log(`  Multi-ticker predictions  (n=${b.multiTicker.n}): ${b.multiTicker.n ? (b.multiTicker.alphaCorrect / b.multiTicker.n * 100).toFixed(1) : 'n/a'}% accuracy`);
    console.log('');
  }
}

main().catch(err => {
  console.error('[diagnose-alpha-mismatch] failed:', err.message);
  process.exit(1);
});
