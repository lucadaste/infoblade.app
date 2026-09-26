// Read-only: full current breakdown of resolved stock/crypto accuracy, to
// check whether the post-cleanup 44-49% overall number is an honest
// reflection of a mostly-zero-source dataset (which we already found tends
// to run below 50%, see diagnose-direction-bias.js) or a sign that
// something else is separately wrong.
//
// Usage: node scripts/diagnose-overall-accuracy.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';

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

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('predictions')
    .select('id, category, sources, analysis, correct, created_at')
    .not('correct', 'is', null)
    .not('winner_tickers', 'is', null)
    .limit(3000);
  if (error) throw error;

  const rows = (data || []).filter(p => p.analysis?.ticker_moves);
  console.log(`Total resolved stock/crypto predictions: ${rows.length}\n`);

  // Overall
  const overallCorrect = rows.filter(p => p.correct).length;
  console.log(`OVERALL: ${overallCorrect}/${rows.length} = ${(overallCorrect/rows.length*100).toFixed(1)}%\n`);

  // By zero-source vs news-driven
  const zeroSource = rows.filter(p => !p.sources || p.sources.length === 0);
  const newsDriven = rows.filter(p => p.sources && p.sources.length > 0);
  console.log(`Zero-source (baseline, no news): n=${zeroSource.length}, accuracy=${(zeroSource.filter(p=>p.correct).length/zeroSource.length*100).toFixed(1)}%`);
  console.log(`News-driven (real sources):      n=${newsDriven.length}, accuracy=${(newsDriven.filter(p=>p.correct).length/newsDriven.length*100).toFixed(1)}%\n`);

  // By star level (zero-source only, since that's the population we've been tracing)
  console.log('Zero-source, by confidence star:');
  const byStar = {};
  for (const p of zeroSource) {
    const star = parseConfidenceStars(p.analysis?.confidence);
    if (!byStar[star]) byStar[star] = { n: 0, correct: 0 };
    byStar[star].n++;
    if (p.correct) byStar[star].correct++;
  }
  for (const star of [1,2,3,4,5]) {
    const b = byStar[star];
    if (!b) { console.log(`  ${star}-star: no data`); continue; }
    console.log(`  ${star}-star: n=${b.n}, accuracy=${(b.correct/b.n*100).toFixed(1)}%`);
  }

  // By scoring_version, to see if there's still an old/new split muddying things
  console.log('\nBy scoring_version:');
  const byVersion = {};
  for (const p of rows) {
    const v = p.analysis?.scoring_version ?? 'unversioned';
    if (!byVersion[v]) byVersion[v] = { n: 0, correct: 0 };
    byVersion[v].n++;
    if (p.correct) byVersion[v].correct++;
  }
  for (const [v, b] of Object.entries(byVersion)) {
    console.log(`  version ${v}: n=${b.n}, accuracy=${(b.correct/b.n*100).toFixed(1)}%`);
  }

  // Direction split, zero-source only — is there still a lopsided bullish/bearish skew?
  console.log('\nZero-source direction split (by whether winners or losers were set):');
  let bullN=0, bullCorrect=0, bearN=0, bearCorrect=0;
  for (const p of zeroSource) {
    const moves = Object.values(p.analysis.ticker_moves);
    const dirs = new Set(moves.map(m => m.direction));
    if (dirs.size === 1 && dirs.has('bullish')) { bullN++; if (p.correct) bullCorrect++; }
    else if (dirs.size === 1 && dirs.has('bearish')) { bearN++; if (p.correct) bearCorrect++; }
  }
  console.log(`  Bullish-only: n=${bullN}, accuracy=${bullN ? (bullCorrect/bullN*100).toFixed(1) : 'n/a'}%`);
  console.log(`  Bearish-only: n=${bearN}, accuracy=${bearN ? (bearCorrect/bearN*100).toFixed(1) : 'n/a'}%`);

  // Still-zero check — did the earlier cleanup catch everything, or is there a new batch?
  const stillAllZero = rows.filter(p => {
    const moves = Object.values(p.analysis.ticker_moves);
    return moves.length && moves.every(m => m.pct === 0);
  });
  console.log(`\nPredictions STILL showing all-zero moves right now: ${stillAllZero.length}`);
  if (stillAllZero.length) {
    console.log('Sample of remaining all-zero ones (created_at, to check if these are NEW post-fix stragglers):');
    for (const p of stillAllZero.slice(0, 15)) {
      console.log(`  ${p.id} created=${p.created_at.slice(0,16)} category=${p.category} correct=${p.correct}`);
    }
  }
}

main().catch(err => {
  console.error('[diagnose-overall-accuracy] failed:', err.message);
  process.exit(1);
});
