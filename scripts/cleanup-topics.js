// Manual, dry-run-by-default cleanup for crypto sub-event predictions saved
// before the skipSave fix. autoAnalyzeGroup topics follow the pattern
// "…: impact on CoinName (SYM) over the next…" — these were saved without
// skipSave:true before the fix, so both the sub-event and the overall
// per-coin prediction ended up in the history.
//
// This used to run unconditionally inside api/predictions.js's handleResolve
// on every cron/page-load resolve pass. Moved here so a regex match against
// `topic` can never silently delete rows with no record of what happened.
//
// Usage:
//   node scripts/cleanup-topics.js            # dry run, logs what WOULD be deleted
//   node scripts/cleanup-topics.js --confirm  # actually deletes, still logs everything
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const SUB_EVENT_RX = /: impact on [A-Z][a-zA-Z\s]+ \([A-Z]+\) over the next/i;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const supabase = getSupabase();

  const { data: subEvents, error } = await supabase
    .from('predictions')
    .select('id, topic, created_at')
    .eq('category', 'crypto-coin')
    .limit(2000);

  if (error) throw error;

  const matches = (subEvents || []).filter(p => SUB_EVENT_RX.test(p.topic || ''));

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const logDir = `${__dirname}/../logs`;
  mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/cleanup-topics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(logPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    mode: confirm ? 'delete' : 'dry-run',
    matchCount: matches.length,
    matches: matches.map(p => ({ id: p.id, topic: p.topic, created_at: p.created_at })),
  }, null, 2));

  console.log(`[cleanup-topics] ${matches.length} matching row(s) found. Log written to ${logPath}`);
  for (const p of matches) console.log(`  ${confirm ? 'DELETE' : 'WOULD DELETE'} ${p.id}  "${p.topic}"`);

  if (!confirm) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete these rows.');
    return;
  }

  if (!matches.length) return;

  const ids = matches.map(p => p.id);
  for (let i = 0; i < ids.length; i += 50) {
    const { error: delErr } = await supabase.from('predictions').delete().in('id', ids.slice(i, i + 50));
    if (delErr) throw delErr;
  }
  console.log(`\nDeleted ${matches.length} row(s). See ${logPath} for the full list.`);
}

main().catch(err => {
  console.error('[cleanup-topics] failed:', err.message);
  process.exit(1);
});
