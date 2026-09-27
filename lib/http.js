import { createClient } from '@supabase/supabase-js';

// Shared request plumbing for api/ routes — Supabase client, CORS headers,
// client IP and the per-IP rate limiter used to be copy-pasted into every
// route with small drifts between copies.

// `required: true` throws when env vars are missing (routes that can't do
// anything without the DB); otherwise returns null and the caller degrades.
export function getSupabase({ required = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    if (required) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
    return null;
  }
  return createClient(url, key);
}

export function setCors(res, { methods = 'GET, OPTIONS', headers = 'Content-Type' } = {}) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

// Fixed 60s window per `${ip}:${route}` in the rate_limits table. No DB means
// no limiting. On a DB error, `failOpen` decides whether the request is let
// through (user-facing reads) or refused (routes that spend LLM budget).
export async function checkRateLimit(supabase, ip, route, limit, { failOpen = false } = {}) {
  if (!supabase) return true;
  const now = new Date();
  const windowStart = new Date(now - 60000);
  const key = `${ip}:${route}`;
  try {
    const { data, error } = await supabase.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
    if (error) return failOpen;
    if (!data || new Date(data.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      return true;
    }
    if (data.count >= limit) return false;
    await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('key', key);
    return true;
  } catch (_) { return failOpen; }
}
