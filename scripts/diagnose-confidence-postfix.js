// One-off scoped re-run of diagnose-confidence.js: restricts to predictions
// created after the anchored 1-5 rubric shipped (feaab9c, 2026-09-15), and
// splits stock/crypto (native 1-5 self-report) from prediction-markets
// (lean_confidence High/Medium/Low -> confidence_weight 5/3/1) since they're
// different scales feeding the same calibration chart. Read-only, no writes.
//
// Usage: node scripts/diagnose-confidence-postfix.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';

const CUTOFF = '2026-09-15T00:00:00Z';
const PM_CATS = new Set(['politics', 'sports', 'entertainment', 'finance', 'tech', 'prediction-markets']);

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

function report(label, rows) {
  console.log(`\n=== ${label} (n=${rows.length}) ===`);
  if (!rows.length) { console.log('  no rows'); return; }
  const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const p of rows) {
    const stars = p.analysis?.confidence_weight ?? parseConfidenceStars(p.analysis?.confidence);
    const bucket = Math.min(5, Math.max(1, Math.round(stars)));
    buckets[bucket].push(p);
  }
  for (const n of [1, 2, 3, 4, 5]) {
    const preds = buckets[n];
    const pct = rows.length ? Math.round(preds.length / rows.length * 100) : 0;
    const correct = preds.filter(p => p.correct).length;
    const correctPct = preds.length ? Math.round(correct / preds.length * 100) : 0;
    console.log(`${n}-star: n=${preds.length} (${pct}% of bucket-total)  correct=${correct}/${preds.length} (${correctPct}%)`);
  }
}

async function main() {
  const supabase = getSupabase();

  // Resolved predictions created after the rubric fix
  const { data: resolved, error: e1 } = await supabase
    .from('predictions')
    .select('id, category, analysis, correct, created_at')
    .not('correct', 'is', null)
    .gte('created_at', CUTOFF)
    .limit(5000);
  if (e1) throw e1;

  // ALL predictions after the fix (resolved or not) — to see raw distribution
  // shape even before outcomes are known (resolution lags by design)
  const { data: allPost, error: e2 } = await supabase
    .from('predictions')
    .select('id, category, analysis, correct, created_at')
    .gte('created_at', CUTOFF)
    .limit(5000);
  if (e2) throw e2;

  console.log(`Predictions created >= ${CUTOFF}: total=${allPost.length}, resolved=${resolved.length}`);

  const stockCryptoAll = allPost.filter(p => !PM_CATS.has(p.category));
  const pmAll = allPost.filter(p => PM_CATS.has(p.category));
  const stockCryptoResolved = resolved.filter(p => !PM_CATS.has(p.category));
  const pmResolved = resolved.filter(p => PM_CATS.has(p.category));

  report('ALL predictions (post-fix) — Stock/Crypto', stockCryptoAll);
  report('ALL predictions (post-fix) — Prediction Markets', pmAll);
  report('RESOLVED predictions (post-fix) — Stock/Crypto', stockCryptoResolved);
  report('RESOLVED predictions (post-fix) — Prediction Markets', pmResolved);

  // Sample a few raw confidence strings from stock/crypto to eyeball the rubric in action
  console.log('\n=== Sample raw stock/crypto confidence strings (post-fix) ===');
  for (const p of stockCryptoAll.slice(0, 8)) {
    console.log(`  [${p.category}] ${JSON.stringify(p.analysis?.confidence ?? null)}`);
  }

  console.log('\n=== Sample raw PM lean_confidence values (post-fix) ===');
  for (const p of pmAll.slice(0, 8)) {
    console.log(`  [${p.category}] ${JSON.stringify(p.analysis?.lean_confidence ?? null)}`);
  }
}

main().catch(err => {
  console.error('[diagnose-confidence-postfix] failed:', err.message);
  process.exit(1);
});
