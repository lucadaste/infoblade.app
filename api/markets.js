import { createClient } from '@supabase/supabase-js';

// Tags are intentionally exclusive — no tag appears in more than one category
const CATEGORY_TAGS = {
  sports:        ['nba', 'nfl', 'mlb', 'nhl', 'mls', 'tennis', 'golf', 'mma', 'boxing', 'soccer', 'basketball', 'football', 'baseball', 'sports'],
  politics:      ['politics', 'elections', 'government', 'congress', 'supreme-court', 'trump'],
  finance:       ['finance', 'economics', 'bitcoin', 'ethereum', 'crypto', 'business', 'markets'],
  entertainment: ['entertainment', 'movies', 'tv', 'awards', 'oscars', 'grammys', 'music', 'celebrity', 'pop-culture', 'culture'],
  tech:          ['tech', 'big-tech', 'ai', 'artificial-intelligence', 'spacex', 'ipo', 'deepseek']
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_TAGS));

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
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
  const key = `${ip}:markets`;
  try {
    const { data } = await supabase.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
    if (!data || new Date(data.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      return true;
    }
    if (data.count >= 30) return false;
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

  const rawCategory = req.query.category;
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'sports';
  const daysCap = Math.min(Math.max(parseInt(req.query.maxDays) || 365, 1), 365);
  const daysMin = Math.min(Math.max(parseInt(req.query.minDays) || 0, 0), daysCap);

  const targetTags = CATEGORY_TAGS[category];

  try {
    const now = new Date();
    const endDateMax = new Date(now.getTime() + daysCap * 86400000).toISOString();
    const endDateMin = new Date(now.getTime() + daysMin * 86400000).toISOString();

    const polyUrl = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=volume24hr&ascending=false&end_date_min=${encodeURIComponent(endDateMin)}&end_date_max=${encodeURIComponent(endDateMax)}`;

    const polyRes = await fetch(
      polyUrl,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    const events = await polyRes.json();
    const filtered = (Array.isArray(events) ? events : []).filter(event => {
      if (!event.active || event.closed || event.archived) return false;
      const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
      return targetTags.some(tag => eventTags.includes(tag));
    });

    const markets = filtered.map(event => {
      const ms = event.markets || [];
      const primary = ms.length === 1
        ? ms[0]
        : [...ms].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];

      if (!primary) return null;

      const endDate = primary.endDate || event.endDate || null;
      const daysLeft = endDate ? Math.ceil((new Date(endDate) - now) / 86400000) : null;

      if (daysLeft !== null && (daysLeft > daysCap || daysLeft < daysMin)) return null;

      let yesPrice = null;
      try {
        const prices = typeof primary.outcomePrices === 'string'
          ? JSON.parse(primary.outcomePrices)
          : primary.outcomePrices;
        yesPrice = Math.round(parseFloat(prices[0]) * 100);
      } catch (_) {}

      if (yesPrice === null || yesPrice < 20 || yesPrice > 80) return null;
      const volume24h = Math.round(parseFloat(event.volume24hr || 0));
      const volumeTotal = Math.round(parseFloat(event.volume || 0));

      return {
        id: event.id,
        slug: event.slug,
        title: String(event.title || '').slice(0, 300),
        question: String(primary.question || event.title || '').slice(0, 300),
        yesPrice,
        volume24h,
        volumeTotal,
        daysLeft,
        totalMarkets: ms.length,
        category
      };
    }).filter(Boolean).slice(0, 10);

    return res.status(200).json({ markets, category });
  } catch (err) {
    console.error('[markets]', err.message);
    return res.status(500).json({ error: 'Failed to load markets' });
  }
}
