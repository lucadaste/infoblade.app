import { createClient } from '@supabase/supabase-js';
import { findGameContextForQuestion } from '../lib/espn-live.js';

// ── Lightweight live-game lookup (no LLM call) ─────────────────────────────
// Powers the LIVE badge + score/period/clock shown directly on sports market
// cards in markets.html, without triggering a full (Claude-backed) analysis.
// Cheap enough to call per-card: just an ESPN scoreboard + summary fetch.
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
  const key = `${ip}:live-game`;
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

  const question = typeof req.query.question === 'string' ? req.query.question.slice(0, 300) : '';
  const sport = typeof req.query.sport === 'string' ? req.query.sport.replace(/[^a-zA-Z]/g, '').slice(0, 20) : null;
  const daysLeft = req.query.daysLeft != null ? parseInt(req.query.daysLeft, 10) : null;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  try {
    const context = await findGameContextForQuestion(question, sport, Number.isFinite(daysLeft) ? daysLeft : null);
    if (!context) return res.status(200).json({ found: false });
    return res.status(200).json({ found: true, ...context });
  } catch (err) {
    console.error('[live-game]', err.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
