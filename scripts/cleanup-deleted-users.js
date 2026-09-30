// One-off, dry-run-by-default cleanup for data left behind by accounts deleted
// before account deletion started erasing user data (api/account.js +
// api/clerk-webhook.js). Finds every user_id in the watchlist tables and
// predictions that no longer exists in Clerk, then runs the same
// deleteUserData() the live deletion path uses (watchlists deleted,
// predictions kept but detached).
//
// Usage:
//   node scripts/cleanup-deleted-users.js            # dry run, lists orphaned user ids + row counts
//   node scripts/cleanup-deleted-users.js --confirm  # actually cleans them up
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_KEY and CLERK_SECRET_KEY (the
// production sk_live_… key) in the environment.

import { createClient } from '@supabase/supabase-js';
import { createClerkClient } from '@clerk/backend';
import { deleteUserData } from '../lib/account-data.js';

const TABLES = ['watchlists', 'crypto_watchlists', 'market_watchlists', 'predictions'];
const PAGE = 1000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
}

// user_id -> { table: rowCount }
async function collectUserIds(sb) {
  const byUser = new Map();
  for (const table of TABLES) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(table).select('user_id').not('user_id', 'is', null).range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      for (const { user_id } of data) {
        const counts = byUser.get(user_id) || {};
        counts[table] = (counts[table] || 0) + 1;
        byUser.set(user_id, counts);
      }
      if (data.length < PAGE) break;
    }
  }
  return byUser;
}

// Returns the subset of ids that Clerk still knows about.
async function existingClerkIds(clerk, ids) {
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { data } = await clerk.users.getUserList({ userId: batch, limit: 100 });
    for (const u of data) existing.add(u.id);
  }
  return existing;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const sb = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_KEY'));
  const clerk = createClerkClient({ secretKey: requireEnv('CLERK_SECRET_KEY') });

  const byUser = await collectUserIds(sb);
  const ids = [...byUser.keys()];
  const existing = await existingClerkIds(clerk, ids);
  const orphaned = ids.filter(id => !existing.has(id));

  console.log(`${ids.length} user ids with stored data, ${existing.size} still in Clerk, ${orphaned.length} orphaned.`);
  if (existing.size === 0 && ids.length > 0) {
    // Almost certainly the wrong Clerk key (e.g. a dev instance) — refuse to
    // treat every real user as deleted.
    throw new Error('No stored user ids exist in this Clerk instance. Is CLERK_SECRET_KEY the production key? Aborting.');
  }

  for (const id of orphaned) console.log(`  ${id}  ${JSON.stringify(byUser.get(id))}`);

  if (!orphaned.length) return;
  if (!confirm) {
    console.log('\nDry run — nothing changed. Re-run with --confirm to clean these up.');
    return;
  }

  let failed = 0;
  for (const id of orphaned) {
    try { await deleteUserData(sb, id); console.log(`cleaned ${id}`); }
    catch (err) { failed++; console.error(`FAILED ${id}: ${err.message}`); }
  }
  console.log(`\nDone. ${orphaned.length - failed} cleaned, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error(err.message); process.exit(1); });
