import { getClerkUser } from '../lib/auth.js';
import { getSupabase, setCors } from '../lib/http.js';

export default async function handler(req, res) {
  setCors(res, { methods: 'GET, POST, DELETE, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getClerkUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase({ required: true });
  // Log DB details server-side; clients only get a generic message.
  const dbError = (error) => {
    console.error('[user-watchlist]', error);
    return res.status(500).json({ error: 'Could not update watchlist' });
  };
  const wlType = req.query.type || 'stocks'; // stocks | crypto | markets

  const TABLE_MAP = {
    stocks:  'watchlists',
    crypto:  'crypto_watchlists',
    markets: 'market_watchlists',
  };
  if (wlType !== 'all' && !TABLE_MAP[wlType]) return res.status(400).json({ error: 'Unknown watchlist type' });
  const table = TABLE_MAP[wlType];

  // Symbols are rendered back into pages, so only accept the shapes the
  // clients actually produce — anything else (e.g. markup) is rejected here.
  const SYMBOL_RE = {
    stocks:  /^(SECTOR:[a-z0-9_-]{1,40}|[A-Z0-9.^-]{1,10})$/,
    crypto:  /^[A-Z0-9]{1,15}$/,
    markets: /^[a-z0-9-]{1,200}$/,
  };
  function validSymbol(symbol) {
    return typeof symbol === 'string' && !!SYMBOL_RE[wlType]?.test(symbol);
  }

  if (req.method === 'GET') {
    if (wlType === 'all') {
      // One request from the client instead of three — each of stocks/crypto/markets
      // used to be a separate fetch (separate token verification + Supabase round
      // trip), which was the main source of lag on the post-login dashboard.
      const [stocksRes, cryptoRes, marketsRes] = await Promise.all([
        sb.from('watchlists').select('symbol').eq('user_id', user.id),
        sb.from('crypto_watchlists').select('symbol').eq('user_id', user.id),
        sb.from('market_watchlists').select('symbol').eq('user_id', user.id),
      ]);
      // A problem with one table (e.g. it doesn't exist yet) shouldn't take down the
      // other two — log it and fall back to an empty list for that type instead of
      // 500ing the whole dashboard.
      [stocksRes, cryptoRes, marketsRes].forEach(r => { if (r.error) console.error('[user-watchlist]', r.error); });
      return res.status(200).json({
        stocks: (stocksRes.data || []).map(r => r.symbol),
        crypto: (cryptoRes.data || []).map(r => r.symbol),
        markets: (marketsRes.data || []).map(r => r.symbol),
      });
    }
    const { data, error } = await sb.from(table).select('symbol').eq('user_id', user.id);
    if (error) return dbError(error);
    return res.status(200).json({ symbols: (data || []).map(r => r.symbol) });
  }

  if (req.method === 'POST') {
    const { symbol } = req.body || {};
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const { error } = await sb.from(table).upsert({ user_id: user.id, symbol }, { onConflict: 'user_id,symbol' });
    if (error) return dbError(error);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { symbol } = req.body || {};
    if (!validSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const { error } = await sb.from(table).delete().eq('user_id', user.id).eq('symbol', symbol);
    if (error) return dbError(error);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
