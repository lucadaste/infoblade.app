import { getClerkUser } from '../lib/auth.js';
import { getSupabase, setCors } from '../lib/http.js';

export default async function handler(req, res) {
  setCors(res, { methods: 'GET, POST, DELETE, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getClerkUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase({ required: true });
  const wlType = req.query.type || 'stocks'; // stocks | crypto | markets

  const TABLE_MAP = {
    stocks:  'watchlists',
    crypto:  'crypto_watchlists',
    markets: 'market_watchlists',
  };
  const table = TABLE_MAP[wlType] || 'watchlists';

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
      const firstError = stocksRes.error || cryptoRes.error || marketsRes.error;
      if (firstError) return res.status(500).json({ error: firstError.message });
      return res.status(200).json({
        stocks: (stocksRes.data || []).map(r => r.symbol),
        crypto: (cryptoRes.data || []).map(r => r.symbol),
        markets: (marketsRes.data || []).map(r => r.symbol),
      });
    }
    const { data, error } = await sb.from(table).select('symbol').eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ symbols: (data || []).map(r => r.symbol) });
  }

  if (req.method === 'POST') {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const { error } = await sb.from(table).upsert({ user_id: user.id, symbol }, { onConflict: 'user_id,symbol' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const { error } = await sb.from(table).delete().eq('user_id', user.id).eq('symbol', symbol);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
