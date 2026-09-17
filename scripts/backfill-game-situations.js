// One-time (or occasionally re-run) historical backfill for game_situations —
// the "similar statline" corpus behind live in-game sports analysis (see the
// plan). Row-building logic lives in lib/game-situation-ingest.js, shared with
// api/ingest-completed-games.js (the daily follow-up cron) so both use exactly
// the same extraction/downsampling.
//
// This is a real offline crawl (hundreds of games x one ~300-600KB summary
// fetch each) — run it with `node`, NOT as a Vercel function; it will run well
// past any serverless timeout. It's resumable: games already present in
// game_situations (checked by game_id before fetching) are skipped, so a
// partial/interrupted run can just be re-launched.
//
// Usage:
//   node scripts/backfill-game-situations.js [nfl|nba|all] [seasons]
//   e.g. node scripts/backfill-game-situations.js all 2
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
// Writes to game_situations. Polite by design: sequential requests with a
// delay between them, not parallel — this is ESPN's undocumented public API.

import { createClient } from '@supabase/supabase-js';
import {
  collectNFLGameIds, collectNBAGameIds, buildSituationRows, gameAlreadyIngested,
} from '../lib/game-situation-ingest.js';

const REQUEST_DELAY_MS = 200;
const SUPPORTED_LEAGUES = ['nfl', 'nba'];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processLeague(supabase, league, seasons) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: seasons }, (_, i) => currentYear - i);

  console.log(`\n=== ${league.toUpperCase()} — seasons: ${years.join(', ')} ===`);

  let allGameIds = [];
  for (const year of years) {
    const collector = league === 'nfl' ? collectNFLGameIds : collectNBAGameIds;
    const ids = await collector(year, { onProgress: () => sleep(REQUEST_DELAY_MS) });
    console.log(`  ${year}: ${ids.length} completed games`);
    allGameIds.push(...ids);
  }
  allGameIds = [...new Set(allGameIds)];
  console.log(`  total unique games: ${allGameIds.length}`);

  let processed = 0, skipped = 0, rowsInserted = 0, failed = 0;
  for (const gameId of allGameIds) {
    if (await gameAlreadyIngested(supabase, gameId)) { skipped++; continue; }

    try {
      const rows = await buildSituationRows(league, gameId);
      if (rows.length) {
        const { error } = await supabase.from('game_situations').insert(rows);
        if (error) throw new Error(error.message);
        rowsInserted += rows.length;
      }
      processed++;
    } catch (err) {
      failed++;
      console.warn(`  [${league}] game ${gameId} failed: ${err.message}`);
    }

    if ((processed + failed) % 25 === 0) {
      console.log(`  progress: ${processed} processed, ${skipped} skipped, ${failed} failed, ${rowsInserted} rows so far`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`  done: ${processed} processed, ${skipped} already present, ${failed} failed, ${rowsInserted} rows inserted`);
}

async function main() {
  const [, , leagueArg = 'all', seasonsArg = '2'] = process.argv;
  const leagues = leagueArg === 'all' ? SUPPORTED_LEAGUES : [leagueArg];
  const seasons = Math.max(1, parseInt(seasonsArg, 10) || 2);

  for (const league of leagues) {
    if (!SUPPORTED_LEAGUES.includes(league)) {
      console.error(`Unsupported league "${league}" — supported: ${SUPPORTED_LEAGUES.join(', ')}`);
      process.exit(1);
    }
  }

  const supabase = getSupabase();
  for (const league of leagues) {
    await processLeague(supabase, league, seasons);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
