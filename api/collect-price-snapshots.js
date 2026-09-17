import { createClient } from '@supabase/supabase-js';
import { SP500_TICKERS } from '../lib/sp500-tickers.js';
import { fetchBatchedQuotes } from '../lib/quote-fetch.js';
import { timeOfDayBucket } from '../lib/situation-similarity-stocks.js';

// ── Forward-collecting price snapshot + situation cron ─────────────────────
// Builds price_snapshots AND stock_situations from scratch, going forward from
// today — Yahoo's free intraday history only goes back ~8 days at 1-minute
// resolution (confirmed live: a 60-day 1m request returns a hard 422), so
// unlike game_situations this can't be backfilled from the past. Runs every 5
// minutes during market hours (see vercel.json).
//
// Each run does three things:
//   1. Fetch current quotes for the S&P 500, insert raw price_snapshots.
//   2. Using recent price_snapshots, compute each ticker's 5m/15m move +
//      relative volume "situation" and insert a stock_situations row
//      (outcome_next_5m left null — not known yet).
//   3. Resolve situations from ~5 minutes ago: look up each ticker's now-
//      current price (already fetched in step 1, no extra query) and fill in
//      outcome_next_5m. This precompute-at-write-time design is what keeps
//      lib/situation-similarity-stocks.js's query a cheap indexed filter
//      instead of a growing self-join over raw snapshots — see
//      supabase-schema.sql's stock_situations comment for why.
const CHUNK_SIZE = 100;
const CHUNK_DELAY_MS = 150;
const RESOLVE_WINDOW_MIN_MIN = 4;   // resolve situations at least this old...
const RESOLVE_WINDOW_MAX_MIN = 10;  // ...but not older than this (bounded scan)

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// NYSE regular session: 9:30am-4:00pm ET, Monday-Friday. Doesn't account for
// market holidays (a holiday just collects a few extra unchanged-price
// snapshots — harmless noise, not worth a full holiday calendar here).
function isMarketHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const weekday = parts.weekday;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutesSinceMidnight = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight <= 16 * 60;
}

async function _fetchAllQuotes() {
  const now = new Date().toISOString();
  const quotes = {};
  for (const batch of chunk(SP500_TICKERS, CHUNK_SIZE)) {
    const batchQuotes = await fetchBatchedQuotes(batch);
    Object.assign(quotes, batchQuotes);
    await sleep(CHUNK_DELAY_MS);
  }
  return { now, quotes };
}

async function _insertSituations(supabase, now, quotes) {
  // One bulk query for the last ~20 minutes across all tickers, grouped in
  // JS — avoids 502 individual per-ticker lookback queries.
  const since = new Date(Date.now() - 20 * 60000).toISOString();
  const { data: recent } = await supabase
    .from('price_snapshots')
    .select('ticker, ts, price, volume')
    .gte('ts', since)
    .order('ts', { ascending: false })
    .limit(15000);

  const byTicker = new Map();
  for (const row of recent || []) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push(row);
  }

  const rows = [];
  for (const [ticker, q] of Object.entries(quotes)) {
    if (q?.price == null) continue;
    const history = byTicker.get(ticker) || [];
    const fiveMinAgo = history.find(r => (Date.now() - new Date(r.ts)) / 60000 >= 5);
    const fifteenMinAgo = history.find(r => (Date.now() - new Date(r.ts)) / 60000 >= 15);
    if (!fiveMinAgo) continue; // not enough history yet for this ticker

    const pctChange5m = fiveMinAgo.price ? (q.price - fiveMinAgo.price) / fiveMinAgo.price * 100 : null;
    const pctChange15m = fifteenMinAgo?.price ? (q.price - fifteenMinAgo.price) / fifteenMinAgo.price * 100 : null;

    const volumes = history.map(r => r.volume).filter(v => v != null);
    const relativeVolume = (q.volume != null && volumes.length >= 3)
      ? q.volume / (volumes.reduce((a, b) => a + b, 0) / volumes.length || 1)
      : null;

    rows.push({
      ticker, ts: now, price: q.price,
      pct_change_5m: pctChange5m != null ? Math.round(pctChange5m * 100) / 100 : null,
      pct_change_15m: pctChange15m != null ? Math.round(pctChange15m * 100) / 100 : null,
      relative_volume: relativeVolume,
      time_of_day_bucket: timeOfDayBucket(new Date(now)),
      outcome_next_5m: null,
    });
  }

  if (rows.length) {
    const { error } = await supabase.from('stock_situations').insert(rows);
    if (error) throw new Error(`stock_situations insert: ${error.message}`);
  }
  return rows.length;
}

async function _resolveOutcomes(supabase, quotes) {
  const minTs = new Date(Date.now() - RESOLVE_WINDOW_MAX_MIN * 60000).toISOString();
  const maxTs = new Date(Date.now() - RESOLVE_WINDOW_MIN_MIN * 60000).toISOString();
  const { data: unresolved } = await supabase
    .from('stock_situations')
    .select('id, ticker, price')
    .is('outcome_next_5m', null)
    .gte('ts', minTs)
    .lte('ts', maxTs)
    .limit(1000);

  let resolved = 0;
  for (const row of unresolved || []) {
    const current = quotes[row.ticker];
    if (current?.price == null || !row.price) continue;
    const outcome = (current.price - row.price) / row.price * 100;
    const { error } = await supabase
      .from('stock_situations')
      .update({ outcome_next_5m: Math.round(outcome * 100) / 100 })
      .eq('id', row.id);
    if (!error) resolved++;
  }
  return resolved;
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

  if (!isMarketHours() && !req.query.force) {
    return res.status(200).json({ skipped: true, reason: 'outside market hours' });
  }

  let supabase;
  try { supabase = _getSupabase(); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  try {
    const { now, quotes } = await _fetchAllQuotes();

    const snapshotRows = Object.entries(quotes)
      .filter(([, q]) => q?.price != null)
      .map(([ticker, q]) => ({ ticker, ts: now, price: q.price, volume: q.volume ?? null }));
    if (snapshotRows.length) {
      const { error } = await supabase.from('price_snapshots').insert(snapshotRows);
      if (error) throw new Error(`price_snapshots insert: ${error.message}`);
    }

    const situationsInserted = await _insertSituations(supabase, now, quotes);
    const situationsResolved = await _resolveOutcomes(supabase, quotes);

    return res.status(200).json({
      tickersRequested: SP500_TICKERS.length,
      snapshotsInserted: snapshotRows.length,
      situationsInserted,
      situationsResolved,
    });
  } catch (err) {
    console.error('[collect-price-snapshots]', err.message);
    return res.status(500).json({ error: 'Collection failed' });
  }
}
