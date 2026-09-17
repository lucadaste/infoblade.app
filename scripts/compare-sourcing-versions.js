// Read-only: does the category-aware prediction-market sourcing pipeline
// (lib/market-source-profiles.js, SOURCING_VERSION) actually produce more
// accurate predictions than the old generic Google-News-+-Reddit pipeline it
// replaced?
//
// IMPORTANT DESIGN LIMITATION: this is a before/after comparison, not a
// controlled experiment. "Before" rows (no analysis.sourcing_version) and
// "after" rows (analysis.sourcing_version set) come from different time
// windows and different real markets — a measured difference is suggestive
// evidence, not proof. A stronger paired/shadow-mode design was considered
// and deliberately deferred (see the project's plan history) in favor of
// shipping this for free using the automated data collection that already
// runs (api/generate-baseline.js's cron, api/predictions.js's resolve/
// news-grade crons) rather than doubling Claude API calls on a sampled subset.
//
// Usage: node scripts/compare-sourcing-versions.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
// Makes no writes.

import { createClient } from '@supabase/supabase-js';
import { wilsonIntervalFromP, twoProportionZTest } from '../lib/stats.js';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

const PM_CATEGORIES = ['sports', 'politics', 'finance', 'entertainment', 'tech'];

function group(preds) {
  const total = preds.length;
  const correct = preds.filter(p => p.correct).length;
  return { total, correct };
}

function pct(g) {
  return g.total ? Math.round((g.correct / g.total) * 100) : null;
}

function ciLabel(g) {
  if (!g.total) return '';
  const ci = wilsonIntervalFromP(g.correct / g.total, g.total);
  return ` [${Math.round(ci.lower * 100)}-${Math.round(ci.upper * 100)}%]`;
}

function report(label, before, after) {
  console.log(`\n${label}`);
  console.log(`  before: n=${before.total}  correct=${before.correct}  accuracy=${pct(before) ?? '-'}%${ciLabel(before)}`);
  console.log(`  after:  n=${after.total}  correct=${after.correct}  accuracy=${pct(after) ?? '-'}%${ciLabel(after)}`);

  const test = twoProportionZTest(before.correct, before.total, after.correct, after.total);
  if (!test) {
    console.log(`  verdict: not enough data yet (need >= 10 graded predictions in each group)`);
    return;
  }
  const direction = test.diff > 0 ? 'improvement' : test.diff < 0 ? 'regression' : 'no change';
  console.log(`  p-value: ${test.pValue.toFixed(4)}`);
  console.log(`  verdict: ${test.significant ? `statistically significant ${direction} (p<0.05)` : 'no statistically significant difference yet'}`);
}

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('predictions')
    .select('id, category, correct, analysis, created_at')
    .not('correct', 'is', null)
    .not('lean', 'is', null) // prediction-market rows only
    .limit(5000);
  if (error) throw error;

  const preds = data || [];
  const before = preds.filter(p => !p.analysis?.sourcing_version);
  const after = preds.filter(p => p.analysis?.sourcing_version);

  console.log(`Total graded prediction-market rows: ${preds.length} (before=${before.length}, after=${after.length})`);
  console.log('NOTE: before/after comparison across different time windows and different real markets — read as suggestive, not proof.');

  report('OVERALL (all PM categories combined)', group(before), group(after));
  for (const cat of PM_CATEGORIES) {
    report(
      cat,
      group(before.filter(p => p.category === cat)),
      group(after.filter(p => p.category === cat)),
    );
  }
}

main().catch(err => {
  console.error('[compare-sourcing-versions] failed:', err.message);
  process.exit(1);
});
