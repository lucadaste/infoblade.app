import { createClient } from '@supabase/supabase-js';

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key);
}

async function _fetchCurrentPrices(tickers) {
  if (!tickers.length) return {};
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
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

function _letterGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  let supabase;
  try { supabase = _getSupabase(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const now = new Date().toISOString();

  // Fetch pending predictions whose validation window has passed
  const { data: pending, error } = await supabase
    .from('predictions')
    .select('id, winner_tickers, loser_tickers, baseline_prices, analysis, category')
    .is('correct', null)
    .not('validation_date', 'is', null)
    .lte('validation_date', now)
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  if (!pending?.length) return res.status(200).json({ resolved: 0 });

  let resolved = 0;

  for (const pred of pending) {
    const winners    = (pred.winner_tickers || []).filter(t => /^[A-Z.]{1,7}$/.test(t));
    const losers     = (pred.loser_tickers  || []).filter(t => /^[A-Z.]{1,7}$/.test(t));
    const allTickers = [...new Set([...winners, ...losers])];
    if (!allTickers.length) continue;

    const baseline = pred.baseline_prices || {};
    const actual   = await _fetchCurrentPrices(allTickers);

    const tickerMoves = {};
    let correctCount = 0;
    let gradedCount  = 0;

    for (const t of winners) {
      if (!actual[t] || !baseline[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const isCorrect = pct >= 0.5;
      tickerMoves[t] = { pct, direction: 'bullish', correct: isCorrect };
      if (isCorrect) correctCount++;
      gradedCount++;
    }
    for (const t of losers) {
      if (!actual[t] || !baseline[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const isCorrect = pct <= -0.5;
      tickerMoves[t] = { pct, direction: 'bearish', correct: isCorrect };
      if (isCorrect) correctCount++;
      gradedCount++;
    }

    if (gradedCount === 0) continue;

    const score   = Math.round(correctCount / gradedCount * 100);
    const correct = score >= 60;
    const grade   = _letterGrade(score);

    const { error: updateErr } = await supabase
      .from('predictions')
      .update({
        correct,
        actual_prices: actual,
        validated_at:  now,
        analysis: {
          ...(pred.analysis || {}),
          grade,
          score,
          ticker_moves: tickerMoves,
        },
      })
      .eq('id', pred.id);

    if (!updateErr) resolved++;
  }

  return res.status(200).json({ resolved });
}
