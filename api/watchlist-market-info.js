import { setCors, checkRateLimit, clientIp, getSupabase } from '../lib/http.js';

// Prediction-market rows in the watchlist tables only ever store the slug
// (see api/user-watchlist.js) — the question text and current odds shown
// when a market was saved only ever lived in the saving device's
// localStorage (see markets.html's toggleMarketWatch). This endpoint
// re-fetches that display info from Polymarket by slug so any device can
// show it — same Gamma API call api/predictions.js already makes
// server-side to grade resolved markets, just for display instead of grading.
const SLUG_RE = /^[a-z0-9-]{1,200}$/;

async function fetchEventBySlug(slug) {
  try {
    const r = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const events = await r.json();
    const event = (Array.isArray(events) ? events[0] : events) || null;
    if (!event) return null;

    const ms = event.markets || [];
    const isCatchAll = m => /\bother\b/i.test(m.groupItemTitle || m.question || '');
    const specific = ms.filter(m => !isCatchAll(m));
    const pool = specific.length > 0 ? specific : ms;
    const primary = pool.length === 1
      ? pool[0]
      : [...pool].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];
    if (!primary) return null;

    let yesPrice = null;
    try {
      const prices = typeof primary.outcomePrices === 'string'
        ? JSON.parse(primary.outcomePrices)
        : primary.outcomePrices;
      yesPrice = Math.round(parseFloat(prices[0]) * 100);
    } catch (_) {}

    return {
      slug,
      question: String(primary.question || event.title || '').slice(0, 300),
      yesPrice: (yesPrice === null || isNaN(yesPrice)) ? null : yesPrice,
      closed: !!event.closed,
    };
  } catch (_) {
    return null;
  }
}

export default async function handler(req, res) {
  setCors(res, { methods: 'GET, OPTIONS', headers: 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'watchlist-market-info', 30);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const slugs = String(req.query.slugs || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => SLUG_RE.test(s))
    .slice(0, 15); // homepage teaser only ever shows a handful

  if (!slugs.length) return res.status(200).json({ markets: [] });

  const results = await Promise.all(slugs.map(fetchEventBySlug));
  return res.status(200).json({ markets: results.filter(Boolean) });
}
