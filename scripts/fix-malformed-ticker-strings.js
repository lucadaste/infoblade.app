// One-time cleanup: replaces malformed "ticker" strings (company names,
// descriptive text) found by the 2026-10 grading audit with their real
// ticker symbols, for display cleanliness only. None of these ever
// affected scoring — the resolver's ticker-shape regex (now also enforced
// at creation time, see lib/ticker-format.js) already excluded them from
// price fetching, so baseline_prices/actual_prices/ticker_moves never had
// an entry for any of them; this just fixes what the prediction card shows
// in winner_tickers/loser_tickers. Each of these 3 predictions is already
// resolved and will never be re-graded regardless (handleResolve only
// looks at correct IS NULL rows), so there's no re-scoring to do here.
//
// Hardcoded list — found by hand, not a heuristic, since there are only 4
// occurrences total:
//   CrowdStrike             -> CRWD  (CrowdStrike Holdings)
//   Palantir                -> PLTR  (Palantir Technologies)
//   BROADCOM                -> AVGO  (Broadcom Inc.)
//   USO_puts_proxy_via_SCO  -> SCO   (ProShares UltraShort Bloomberg Crude Oil —
//                                     the actual tradeable proxy the string names)
//
// Dry-run by default — prints what WOULD change. Pass --write to actually
// update the database.
//
// Usage: node scripts/fix-malformed-ticker-strings.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';

const WRITE = process.argv.includes('--write');

const FIXES = {
  CrowdStrike: 'CRWD',
  Palantir: 'PLTR',
  BROADCOM: 'AVGO',
  USO_puts_proxy_via_SCO: 'SCO',
};

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

function fixList(tickers) {
  if (!tickers?.length) return { changed: false, tickers };
  let changed = false;
  const out = tickers.map(t => {
    if (FIXES[t]) { changed = true; return FIXES[t]; }
    return t;
  });
  return { changed, tickers: out };
}

async function main() {
  const supabase = getSupabase();
  const badStrings = Object.keys(FIXES);
  const orFilter = badStrings.flatMap(s => [`winner_tickers.cs.{${s}}`, `loser_tickers.cs.{${s}}`]).join(',');

  const { data: rows, error } = await supabase
    .from('predictions')
    .select('id, topic, winner_tickers, loser_tickers')
    .or(orFilter);
  if (error) throw error;

  console.log(`Found ${rows?.length ?? 0} row(s) containing a known malformed ticker string.\n`);
  const updates = [];
  for (const p of rows || []) {
    const w = fixList(p.winner_tickers);
    const l = fixList(p.loser_tickers);
    if (!w.changed && !l.changed) continue;
    console.log(`  ${p.id} (${p.topic})`);
    if (w.changed) console.log(`    winner_tickers: ${JSON.stringify(p.winner_tickers)} -> ${JSON.stringify(w.tickers)}`);
    if (l.changed) console.log(`    loser_tickers:  ${JSON.stringify(p.loser_tickers)} -> ${JSON.stringify(l.tickers)}`);
    updates.push({ id: p.id, winner_tickers: w.tickers, loser_tickers: l.tickers });
  }

  if (!updates.length) { console.log('Nothing to fix.'); return; }

  if (!WRITE) {
    console.log(`\nDry run only — pass --write to apply these ${updates.length} updates to the database.`);
    return;
  }

  console.log(`\nWriting ${updates.length} updates...`);
  let written = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase.from('predictions')
      .update({ winner_tickers: u.winner_tickers, loser_tickers: u.loser_tickers })
      .eq('id', u.id);
    if (upErr) console.error(`  FAILED ${u.id}:`, upErr.message);
    else written++;
  }
  console.log(`Done. ${written}/${updates.length} rows updated.`);
}

main().catch(err => {
  console.error('[fix-malformed-ticker-strings] failed:', err.message);
  process.exit(1);
});
