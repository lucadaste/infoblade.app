import { createClient } from '@supabase/supabase-js';
import { buildContextGraph } from '../lib/context-graph.js';

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICEKEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key);
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  let supabase;
  try { supabase = _getSupabase(); } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const tickers = (req.query.tickers || '')
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(t => /^[A-Z.]{1,7}$/.test(t))
    .slice(0, 20);

  const category = req.query.category || null;

  try {
    const graph = await buildContextGraph(supabase, { tickers, category });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(graph ?? { overall: null, categoryAccuracy: null, tickerHistory: [], recentPredictions: [] });
  } catch (err) {
    console.error('[context-graph]', err.message);
    return res.status(500).json({ error: 'Failed to build context graph' });
  }
}
