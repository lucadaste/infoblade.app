import { fetchBatchedQuotes } from '../lib/quote-fetch.js';
import { setCors, checkRateLimit, clientIp, getSupabase } from '../lib/http.js';

// Live price + daily % change for arbitrary saved tickers, for the home-page
// Watchlist preview — mirrors api/sector-stocks.js's quote path (Robinhood
// first, Yahoo fallback) via the shared lib/quote-fetch.js helper, just for
// a user's own tickers instead of a fixed sector list.
const TICKER_RE = /^[A-Z0-9.-]{1,10}$/;

export default async function handler(req, res) {
  setCors(res, { methods: 'GET, OPTIONS', headers: 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'watchlist-stock-quotes', 30);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const symbols = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => TICKER_RE.test(s))
    .slice(0, 15); // homepage teaser only ever shows a handful

  if (!symbols.length) return res.status(200).json({ quotes: {} });

  try {
    const quotes = await fetchBatchedQuotes(symbols);
    return res.status(200).json({ quotes });
  } catch (err) {
    console.error('[watchlist-stock-quotes]', err);
    return res.status(200).json({ quotes: {} });
  }
}
