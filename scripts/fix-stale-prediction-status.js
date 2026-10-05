// One-time cleanup for two data-consistency issues found while investigating
// why the resolve cron appeared stalled (it wasn't — `status` turned out to
// be an unreliable signal; `correct IS NULL` is the authoritative one, see
// _resolvePriceBased in api/predictions.js):
//
// 1. "Stale resolved" rows: status is still 'pending' even though `correct`
//    and `validated_at` are already set — i.e. they WERE graded, just never
//    got their status flipped to 'resolved'. Cosmetic (nothing in the
//    resolve/grading path trusts `status` over `correct`), but anything else
//    that filters on status='pending' would wrongly count these as
//    outstanding work forever. Fixed by setting status: 'resolved'.
//
// 2. "Zombie" rows: lean IS NULL (stock/crypto), correct IS NULL, status
//    not yet 'failed', but BOTH winner_tickers and loser_tickers are empty.
//    These can never be graded (there's nothing to compare against price
//    history) but also never get marked 'failed' by the normal retry path,
//    because _resolvePriceBased's per-row filter drops them before they're
//    ever claimed — so they silently sit "pending" forever and keep getting
//    re-fetched (for nothing) by every future resolve pass. Fixed by marking
//    them 'failed' directly (same terminal state as retry-exhausted rows),
//    tagged with analysis.fail_reason so they're distinguishable from a
//    genuine price-fetch failure if anyone audits `failed` rows later.
//
// Dry-run by default — prints what WOULD change. Pass --write to apply.
//
// Usage: node scripts/fix-stale-prediction-status.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';

const WRITE = process.argv.includes('--write');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

async function main() {
  const supabase = getSupabase();

  // ── 1. Stale "pending" rows that are actually already resolved ───────────
  const { data: stale, error: staleErr } = await supabase
    .from('predictions')
    .select('id')
    .eq('status', 'pending')
    .not('correct', 'is', null);
  if (staleErr) throw staleErr;
  console.log(`Stale-status rows (already graded, status still 'pending'): ${stale.length}`);

  // ── 2. Zombie rows: ungraded, overdue-or-not, but no tickers at all ──────
  const { data: zombies, error: zombieErr } = await supabase
    .from('predictions')
    .select('id, topic, created_at')
    .is('lean', null)
    .is('correct', null)
    .neq('status', 'failed')
    .eq('winner_tickers', '{}')
    .eq('loser_tickers', '{}');
  if (zombieErr) throw zombieErr;
  console.log(`Zombie rows (no tickers, can never be graded): ${zombies.length}`);
  for (const z of zombies.slice(0, 10)) console.log(`  [${z.id}] "${z.topic}" created ${z.created_at?.slice(0,10)}`);
  if (zombies.length > 10) console.log(`  ... and ${zombies.length - 10} more`);

  if (!WRITE) {
    console.log('\nDry run only — pass --write to apply changes.');
    return;
  }

  let staleFixed = 0;
  for (let i = 0; i < stale.length; i += 200) {
    const chunk = stale.slice(i, i + 200).map(r => r.id);
    const { error } = await supabase.from('predictions').update({ status: 'resolved' }).in('id', chunk);
    if (!error) staleFixed += chunk.length; else console.error('  stale-fix batch failed:', error.message);
  }
  console.log(`Fixed ${staleFixed} stale-status rows.`);

  let zombiesFixed = 0;
  for (const z of zombies) {
    const { data: full } = await supabase.from('predictions').select('analysis').eq('id', z.id).single();
    const { error } = await supabase.from('predictions').update({
      status: 'failed',
      retry_count: 5,
      resolving_since: null,
      analysis: { ...(full?.analysis || {}), fail_reason: 'no_tickers_at_creation' },
    }).eq('id', z.id);
    if (!error) zombiesFixed++; else console.error(`  zombie-fix failed for ${z.id}:`, error.message);
  }
  console.log(`Marked ${zombiesFixed} zombie rows as failed.`);
}

main().catch(err => {
  console.error('[fix-stale-prediction-status] failed:', err.message);
  process.exit(1);
});
