// Read-only follow-up to diagnose-alpha-mismatch.js: is the 1-star bucket's
// catastrophic accuracy (1.7% under the current scoring version) driven by a
// lopsided bullish/bearish split running into one bad stretch, or is it
// roughly balanced (which would point toward a real bug rather than an
// unlucky concentration)? Also prints created_at date range so we can tell
// whether this is a narrow, single-event time window or spread out.
//
// Usage: node scripts/diagnose-direction-bias.js
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
    .select('id, category, sources, analysis, correct, created_at, validation_date, winner_tickers, loser_tickers')
    .not('correct', 'is', null)
    .not('winner_tickers', 'is', null)
    .limit(3000);
  if (error) throw error;

  const rows = (data || []).filter(p => p.analysis?.ticker_moves && p.analysis?.scoring_version === 3);
  const zeroSource1Star = rows.filter(p =>
    (!p.sources || p.sources.length === 0) && parseConfidenceStars(p.analysis?.confidence) === 1
  );

  console.log(`Zero-source, 1-star, scoring_version=3 predictions: ${zeroSource1Star.length}\n`);

  let bullishCount = 0, bearishCount = 0, mixedCount = 0;
  let bullishCorrect = 0, bearishCorrect = 0;
  const dates = [];

  for (const p of zeroSource1Star) {
    dates.push(p.created_at);
    const hasWinners = (p.winner_tickers || []).length > 0;
    const hasLosers  = (p.loser_tickers  || []).length > 0;
    if (hasWinners && !hasLosers) {
      bullishCount++;
      if (p.correct) bullishCorrect++;
    } else if (hasLosers && !hasWinners) {
      bearishCount++;
      if (p.correct) bearishCorrect++;
    } else {
      mixedCount++;
    }
  }

  dates.sort();
  console.log(`Direction split:`);
  console.log(`  Bullish-only predictions: ${bullishCount} (${bullishCount ? (bullishCorrect/bullishCount*100).toFixed(1) : 0}% correct)`);
  console.log(`  Bearish-only predictions: ${bearishCount} (${bearishCount ? (bearishCorrect/bearishCount*100).toFixed(1) : 0}% correct)`);
  console.log(`  Mixed winners+losers in one prediction: ${mixedCount}`);
  console.log('');
  console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);

  // Print every single one in full detail — n is small (~58), worth seeing all of them
  console.log(`\nFull detail:`);
  for (const p of zeroSource1Star) {
    const moves = p.analysis.ticker_moves;
    const detail = Object.entries(moves).map(([t, m]) => `${t}(${m.direction},${m.pct}%)`).join(' ');
    console.log(`  ${p.created_at.slice(0,10)} correct=${p.correct} category=${p.category} :: ${detail}`);
  }
}

main().catch(err => {
  console.error('[diagnose-direction-bias] failed:', err.message);
  process.exit(1);
});
