import { createClient } from '@supabase/supabase-js';
import { computeCurrentFeatures, findSimilarMoves } from '../lib/situation-similarity-stocks.js';

// ── Lightweight short-horizon stock situation lookup (no LLM call) ─────────
// Powers a small stat block on feed.html's per-ticker analysis panel:
// "in similar past situations, how has this stock tended to move over the
// next 5 minutes?" Presented as historical statistical context, not a
// trading signal — see lib/situation-similarity-stocks.js's header comment.
// Returns { found: false } until the forward-collecting price-snapshot cron
// (api/collect-price-snapshots.js) has built up enough history — expected to
// be the case for the first while after this ships, not a bug.
function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function _checkRateLimit(supabase, ip) {
  if (!supabase) return true;
  const now = new Date();
  const windowStart = new Date(now - 60000);
  const key = `${ip}:stock-situation`;
  try {
    const { data } = await supabase.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
    if (!data || new Date(data.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      return true;
    }
    if (data.count >= 60) return false;
    await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('key', key);
    return true;
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const supabase = _getSupabase();
  const allowed = await _checkRateLimit(supabase, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10) : '';
  if (!ticker) return res.status(400).json({ error: 'No ticker provided' });
  if (!supabase) return res.status(200).json({ found: false });

  try {
    const features = await computeCurrentFeatures(supabase, ticker);
    if (!features || features.pctChange5m == null) return res.status(200).json({ found: false });

    const similarMoves = await findSimilarMoves(supabase, {
      pctChange5m: features.pctChange5m,
      timeOfDayBucketVal: features.timeOfDayBucket,
    });

    if (!similarMoves) return res.status(200).json({ found: false, features });
    return res.status(200).json({ found: true, features, similarMoves });
  } catch (err) {
    console.error('[stock-situation]', err.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
