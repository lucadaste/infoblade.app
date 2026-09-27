// Read-only: did moving the analysis prompts' fixed rules into a cached system
// prefix (lib/prompt-layout.js, PROMPT_LAYOUT_VERSION) change graded accuracy?
// The rule text is the same; only its position relative to the per-request
// data moved, which can still shift the model's calls.
//
// Same before/after design limitation as scripts/compare-sourcing-versions.js:
// the two groups come from different time windows and different events, so a
// measured difference is suggestive, not proof. To keep the windows close,
// "before" is limited to the 30 days preceding the first new-layout row.
//
// Usage: node scripts/compare-prompt-layouts.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
// Makes no writes.

import { getSupabase } from '../lib/http.js';
import { wilsonIntervalFromP, twoProportionZTest } from '../lib/stats.js';
import { categoryToSection } from '../lib/prediction-sections.js';

const BEFORE_WINDOW_DAYS = 30;

function group(preds) {
  return { total: preds.length, correct: preds.filter(p => p.correct).length };
}

function line(name, g) {
  if (!g.total) return `  ${name}: n=0`;
  const ci = wilsonIntervalFromP(g.correct / g.total, g.total);
  return `  ${name}: n=${g.total}  correct=${g.correct}  accuracy=${Math.round(g.correct / g.total * 100)}% [${Math.round(ci.lower * 100)}-${Math.round(ci.upper * 100)}%]`;
}

function report(label, before, after) {
  console.log(`\n${label}`);
  console.log(line('before', before));
  console.log(line('after ', after));
  const test = twoProportionZTest(before.correct, before.total, after.correct, after.total);
  if (!test) {
    console.log('  verdict: not enough data yet (need >= 10 graded predictions in each group)');
    return;
  }
  const direction = test.diff > 0 ? 'improvement' : test.diff < 0 ? 'regression' : 'no change';
  console.log(`  p-value: ${test.pValue.toFixed(4)}`);
  console.log(`  verdict: ${test.significant ? `statistically significant ${direction} (p<0.05)` : 'no statistically significant difference yet'}`);
}

async function main() {
  const supabase = getSupabase({ required: true });

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('predictions')
      .select('category, lean, correct, created_at, analysis->>prompt_layout')
      .not('correct', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const after = rows.filter(r => r.prompt_layout);
  if (!after.length) {
    console.log('No graded predictions with a prompt_layout yet — check back once new predictions resolve.');
    return;
  }
  const firstAfter = new Date(after[0].created_at).getTime();
  const windowStart = firstAfter - BEFORE_WINDOW_DAYS * 86400000;
  const before = rows.filter(r => !r.prompt_layout && new Date(r.created_at).getTime() >= windowStart);

  const sectionOf = r => (r.lean ? 'prediction-markets' : categoryToSection(r.category || 'any'));
  console.log(`Graded rows: before=${before.length} (last ${BEFORE_WINDOW_DAYS} days of the old layout), after=${after.length}`);
  console.log('NOTE: before/after comparison across different time windows — read as suggestive, not proof.');

  report('OVERALL', group(before), group(after));
  for (const section of ['stocks', 'crypto', 'prediction-markets']) {
    report(section, group(before.filter(r => sectionOf(r) === section)), group(after.filter(r => sectionOf(r) === section)));
  }
}

main().catch(err => {
  console.error('[compare-prompt-layouts] failed:', err.message);
  process.exit(1);
});
