// Read-only diagnostic: why does the 3-star calibration bucket underperform
// 2-star and 4-star? Checks whether predictions landing in "3 stars" got
// there because the model genuinely wrote "3 — ..." vs. because
// _parseConfidenceStars silently defaulted a missing/unparseable
// analysis.confidence field to 3 (api/predictions.js).
//
// Usage: node scripts/diagnose-confidence.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
// Makes no writes.

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

  const { data: validated, error } = await supabase
    .from('predictions')
    .select('id, category, analysis, correct')
    .not('correct', 'is', null)
    .limit(2000);
  if (error) throw error;

  const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const p of validated || []) {
    const stars = p.analysis?.confidence_weight ?? parseConfidenceStars(p.analysis?.confidence);
    const bucket = Math.min(5, Math.max(1, Math.round(stars)));
    buckets[bucket].push(p);
  }

  console.log(`Total resolved: ${validated.length}\n`);
  for (const n of [1, 2, 3, 4, 5]) {
    const preds = buckets[n];
    const missing    = preds.filter(p => !p.analysis?.confidence).length;
    const malformed  = preds.filter(p => p.analysis?.confidence && !/^\s*[1-5]/.test(String(p.analysis.confidence))).length;
    const genuine    = preds.filter(p => p.analysis?.confidence && new RegExp(`^\\s*${n}\\b`).test(String(p.analysis.confidence))).length;
    const correct    = preds.filter(p => p.correct).length;
    console.log(`${n}-star: n=${preds.length}  correct=${correct} (${preds.length ? Math.round(correct / preds.length * 100) : 0}%)`);
    console.log(`   genuinely stated "${n} — ...": ${genuine}`);
    console.log(`   missing analysis.confidence:  ${missing}`);
    console.log(`   present but unparseable:      ${malformed}`);
    // Sample a few raw confidence strings so we can eyeball what's really there
    const sample = preds.slice(0, 3).map(p => JSON.stringify(p.analysis?.confidence ?? null));
    console.log(`   sample raw values: ${sample.join(', ')}\n`);
  }
}

main().catch(err => {
  console.error('[diagnose-confidence] failed:', err.message);
  process.exit(1);
});
