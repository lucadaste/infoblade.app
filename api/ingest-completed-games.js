import { createClient } from '@supabase/supabase-js';
import { collectCompletedGameIdsForDate, buildSituationRows, gameAlreadyIngested } from '../lib/game-situation-ingest.js';

// ── Daily game_situations top-up ────────────────────────────────────────────
// Keeps the historical "similar statline" dataset (lib/situation-similarity.js)
// growing after the initial scripts/backfill-game-situations.js sweep, without
// re-running the full historical crawl. Pulls yesterday's completed NFL/NBA
// games only — small enough to comfortably fit one Vercel invocation — and
// reuses the exact same row-building logic the backfill script uses.
const SUPPORTED_LEAGUES = ['nfl', 'nba'];

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key);
}

function _yesterdayDateParam() {
  const d = new Date(Date.now() - 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const cronSecret   = process.env.CRON_SECRET;
  const manualSecret = process.env.VALIDATE_SECRET;
  const authHeader    = req.headers['authorization'];
  const manualToken   = req.query.secret || req.headers['x-validate-secret'];

  const isCron   = cronSecret   && authHeader === `Bearer ${cronSecret}`;
  const isManual = manualSecret && manualToken === manualSecret;
  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  let supabase;
  try { supabase = _getSupabase(); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  const dateParam = req.query.date || _yesterdayDateParam();
  const summary = {};

  try {
    for (const league of SUPPORTED_LEAGUES) {
      const gameIds = await collectCompletedGameIdsForDate(league, dateParam);
      let processed = 0, skipped = 0, rowsInserted = 0, failed = 0;

      for (const gameId of gameIds) {
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
          console.error(`[ingest-completed-games] ${league} game ${gameId}:`, err.message);
        }
      }

      summary[league] = { gamesFound: gameIds.length, processed, skipped, failed, rowsInserted };
    }

    return res.status(200).json({ date: dateParam, ...summary });
  } catch (err) {
    console.error('[ingest-completed-games]', err.message);
    return res.status(500).json({ error: 'Ingest failed' });
  }
}
