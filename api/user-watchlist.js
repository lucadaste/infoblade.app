import { createClient } from '@supabase/supabase-js';
import { getClerkUser } from '../lib/auth.js';

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function _getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getClerkUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sb = _getSupabase();
  const wlType = req.query.type || 'stocks'; // stocks | crypto | markets

  const TABLE_MAP = {
    stocks:  'watchlists',
    crypto:  'crypto_watchlists',
    markets: 'market_watchlists',
  };
  const table = TABLE_MAP[wlType] || 'watchlists';

  if (req.method === 'GET') {
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
