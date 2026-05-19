import { createClient } from '@supabase/supabase-js';

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key);
}

function _parseTimeframeDays(str) {
  if (!str) return 7;
  const s = str.toLowerCase();
  const n = parseInt((s.match(/(\d+)/) || [])[1] || '1', 10);
  if (s.includes('day'))   return Math.min(n, 30);
  if (s.includes('week'))  return Math.min(n * 7, 90);
  if (s.includes('month')) return Math.min(n * 30, 365);
  return 7;
}

async function _fetchBaselinePrices(tickers) {
  if (!tickers.length) return {};
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    const d = await r.json();
    const prices = {};
    for (const q of d?.quoteResponse?.result || []) {
      if (q.regularMarketPrice) prices[q.symbol] = +q.regularMarketPrice.toFixed(4);
    }
    return prices;
  } catch (_) { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let supabase;
  try { supabase = _getSupabase(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const { topic, direction, confidence, impactTimeframe, winnerTickers, loserTickers, category } = req.body || {};
  if (!topic?.trim()) return res.status(400).json({ error: 'topic required' });

  const winners = (winnerTickers || []).filter(t => /^[A-Z.]{1,7}$/.test(t)).slice(0, 20);
  const losers  = (loserTickers  || []).filter(t => /^[A-Z.]{1,7}$/.test(t)).slice(0, 20);
  if (!winners.length && !losers.length) return res.status(400).json({ error: 'no trackable tickers' });

  const topicTrimmed = topic.trim().slice(0, 300);
  const twoHoursAgo  = new Date(Date.now() - 7200000).toISOString();

  // Deduplicate — skip if same topic was saved in the last 2 hours
  const { count } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .eq('topic', topicTrimmed)
    .gte('created_at', twoHoursAgo);
  if (count > 0) return res.status(200).json({ ok: true, skipped: true });

  const days           = _parseTimeframeDays(impactTimeframe);
  const validationDate = new Date(Date.now() + days * 86400000).toISOString();
  const allTickers     = [...new Set([...winners, ...losers])];
  const baselinePrices = await _fetchBaselinePrices(allTickers);

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const { error } = await supabase.from('predictions').insert({
    id,
    topic: topicTrimmed,
    winner_tickers: winners,
    loser_tickers:  losers,
    category:       category || 'any',
    analysis:       { confidence, impact_timeframe: impactTimeframe, direction },
    baseline_prices: baselinePrices,
    validation_date: validationDate,
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id, validationDate });
}
