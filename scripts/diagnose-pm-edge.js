// Read-only: do our prediction-market calls actually beat the crowd? Markets on
// the platform are pre-filtered to 15-85% Yes (api/markets.js), and simply
// picking the crowd favorite on that range wins a large share on its own, so
// the raw hit rate means little without that baseline. Breaks hit rate down by
// agree/disagree with the market, odds band, confidence, and category, then
// simulates the "close call" rule (api/market-analyze.js) at a few cutoffs so
// we can pick the threshold from data instead of guessing.
//
// Usage: node scripts/diagnose-pm-edge.js [--version=<pm_model_version>]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

function parseStars(conf) {
  const m = String(conf || '').match(/^\s*([1-5])/);
  if (m) return parseInt(m[1]);
  if (conf === 'High') return 5;
  if (conf === 'Medium') return 3;
  if (conf === 'Low') return 1;
  return null;
}

const pct = (n, d) => d ? `${(n / d * 100).toFixed(1)}%` : '—';

function row(label, rows) {
  const n = rows.length;
  const ours = rows.filter(r => r.correct).length;
  const withOdds = rows.filter(r => r.crowdCorrect != null);
  const crowd = withOdds.filter(r => r.crowdCorrect).length;
  return `${label.padEnd(28)} n=${String(n).padStart(5)}   ours ${pct(ours, n).padStart(6)}   crowd ${pct(crowd, withOdds.length).padStart(6)}`;
}

function table(title, groups) {
  console.log(`\n── ${title} ──`);
  for (const [label, rows] of groups) console.log(row(label, rows));
}

async function fetchAll(supabase) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('predictions')
      .select('id, created_at, category, lean, lean_confidence, market_odds_at_time, signal, correct, analysis, model_probability')
      .in('lean', ['Yes', 'No'])
      .not('correct', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // model_probability may not exist yet if the schema migration hasn't run
      if (/model_probability/.test(error.message)) return fetchAllLegacy(supabase);
      throw error;
    }
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function fetchAllLegacy(supabase) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('predictions')
      .select('id, created_at, category, lean, lean_confidence, market_odds_at_time, signal, correct, analysis')
      .in('lean', ['Yes', 'No'])
      .not('correct', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const versionArg = process.argv.find(a => a.startsWith('--version='))?.split('=')[1] || null;
  const supabase = getSupabase();
  let raw = await fetchAll(supabase);
  if (versionArg) raw = raw.filter(p => p.analysis?.pm_model_version === versionArg);

  const rows = raw.map(p => {
    const odds = p.market_odds_at_time;
    const resolved = p.analysis?.resolved_outcome || (p.correct ? p.lean : (p.lean === 'Yes' ? 'No' : 'Yes'));
    // Crowd favorite: the side priced above 50%. Exactly 50 has no favorite.
    const crowdPick = odds == null || odds === 50 ? null : (odds > 50 ? 'Yes' : 'No');
    const agreesWithCrowd = crowdPick ? p.lean === crowdPick : null;
    const modelProb = p.model_probability ?? p.analysis?.yes_probability ?? null;
    return {
      ...p,
      odds,
      resolved,
      crowdCorrect: crowdPick ? crowdPick === resolved : null,
      agreesWithCrowd,
      stars: parseStars(p.lean_confidence || p.analysis?.lean_confidence),
      gap: modelProb != null && odds != null ? Math.abs(modelProb - odds) : null,
      modelProb,
    };
  });

  if (!rows.length) { console.log('No graded prediction-market rows found.'); return; }

  console.log(`Graded PM predictions: ${rows.length}${versionArg ? ` (pm_model_version=${versionArg})` : ''}`);
  console.log(`Date range: ${rows[0].created_at.slice(0, 10)} → ${rows[rows.length - 1].created_at.slice(0, 10)}`);
  console.log(`Rows with market odds captured: ${rows.filter(r => r.odds != null).length}`);

  table('Headline: us vs. always picking the crowd favorite', [['All calls', rows]]);

  // Brier score: crowd's implied probability vs. outcome (lower is better).
  const withOdds = rows.filter(r => r.odds != null);
  if (withOdds.length) {
    const brier = withOdds.reduce((s, r) => s + ((r.odds / 100) - (r.resolved === 'Yes' ? 1 : 0)) ** 2, 0) / withOdds.length;
    console.log(`Crowd Brier score: ${brier.toFixed(4)} (0 = perfect, 0.25 = coin flip)`);
    const withProb = withOdds.filter(r => r.gap != null);
    if (withProb.length) {
      const mb = withProb.reduce((s, r) => s + (((r.model_probability ?? r.analysis?.yes_probability) / 100) - (r.resolved === 'Yes' ? 1 : 0)) ** 2, 0) / withProb.length;
      const cb = withProb.reduce((s, r) => s + ((r.odds / 100) - (r.resolved === 'Yes' ? 1 : 0)) ** 2, 0) / withProb.length;
      console.log(`On ${withProb.length} rows with a model probability: model Brier ${mb.toFixed(4)} vs crowd ${cb.toFixed(4)}`);
    }
  }

  table('Agree vs. disagree with the crowd favorite', [
    ['Agrees with crowd', rows.filter(r => r.agreesWithCrowd === true)],
    ['Disagrees with crowd', rows.filter(r => r.agreesWithCrowd === false)],
    ['No odds captured', rows.filter(r => r.agreesWithCrowd == null)],
  ]);

  table('By model-reported signal', ['Aligns with market', 'Contradicts market', 'Inconclusive'].map(s =>
    [s, rows.filter(r => r.signal === s)]));

  table('By market odds (Yes %) at call time', [
    ['< 15', r => r.odds < 15], ['15-35', r => r.odds >= 15 && r.odds < 35], ['35-50', r => r.odds >= 35 && r.odds < 50],
    ['50-65', r => r.odds >= 50 && r.odds < 65], ['65-85', r => r.odds >= 65 && r.odds <= 85], ['> 85', r => r.odds > 85],
  ].map(([l, f]) => [l, rows.filter(r => r.odds != null && f(r))]));

  table('By confidence stars', [1, 2, 3, 4, 5].map(s => [`${s} star`, rows.filter(r => r.stars === s)]));

  const cats = [...new Set(rows.map(r => r.category || 'unknown'))].sort();
  table('By category', cats.map(c => [c, rows.filter(r => (r.category || 'unknown') === c)]));

  // Close-call simulation: what if we had shown a briefing instead of a call?
  console.log('\n── Close-call simulation (skipped calls become briefings, not graded) ──');
  const sim = (label, skip) => {
    const kept = rows.filter(r => !skip(r));
    const ok = kept.filter(r => r.correct).length;
    console.log(`${label.padEnd(44)} calls kept ${pct(kept.length, rows.length).padStart(6)}   hit rate ${pct(ok, kept.length).padStart(6)}`);
  };
  sim('Current (no skipping)', () => false);
  sim('Skip confidence <= 2', r => r.stars != null && r.stars <= 2);
  sim('Skip weak disagreements (conf <= 3)', r => r.agreesWithCrowd === false && r.stars != null && r.stars <= 3);
  sim('Skip confidence <= 2 OR weak disagreement', r => (r.stars != null && r.stars <= 2) || (r.agreesWithCrowd === false && r.stars != null && r.stars <= 3));
  sim('Skip all disagreements', r => r.agreesWithCrowd === false);
  // Proxy for the live rule on legacy rows (no model probability yet): the
  // market's own odds near 50 means the crowd also sees a coin flip.
  for (const cut of [5, 8, 10, 15]) {
    sim(`Skip market odds within ${cut} of 50 OR conf <= 2`, r => (r.odds != null && Math.abs(r.odds - 50) < cut) || (r.stars != null && r.stars <= 2));
  }
  if (rows.some(r => r.modelProb != null)) {
    // The live rule in api/market-analyze.js (CLOSE_CALL_MARGIN) ...
    for (const cut of [5, 8, 10, 15]) {
      sim(`Skip model prob within ${cut} of 50 OR conf <= 2`, r => (r.modelProb != null && Math.abs(r.modelProb - 50) < cut) || (r.stars != null && r.stars <= 2));
    }
    // ... vs. the alternative "barely differs from the crowd" rule.
    for (const cut of [5, 8, 10, 15]) {
      sim(`Skip model-vs-crowd gap < ${cut} OR conf <= 2`, r => (r.gap != null && r.gap < cut) || (r.stars != null && r.stars <= 2));
    }
  } else {
    console.log('(Model-probability cutoffs appear once rows have model_probability. Rerun after new data accumulates.)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
