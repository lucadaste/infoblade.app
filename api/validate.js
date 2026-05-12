import { createClient } from '@supabase/supabase-js';

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

async function _fetchCurrentPrices(tickers) {
  if (!tickers.length) return {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    const prices = {};
    for (const q of data?.quoteResponse?.result || []) {
      if (q.regularMarketPrice) prices[q.symbol] = q.regularMarketPrice;
    }
    return prices;
  } catch (_) { return {}; }
}

// A ticker direction is correct if it moved >= 0.5% the predicted way.
function _scoreDirections(winnerTickers, loserTickers, baseline, current) {
  let correct = 0, incorrect = 0, neutral = 0;
  for (const t of winnerTickers) {
    if (!baseline[t] || !current[t]) continue;
    const chg = (current[t] - baseline[t]) / baseline[t];
    if (chg > 0.005) correct++;
    else if (chg < -0.005) incorrect++;
    else neutral++;
  }
  for (const t of loserTickers) {
    if (!baseline[t] || !current[t]) continue;
    const chg = (current[t] - baseline[t]) / baseline[t];
    if (chg < -0.005) correct++;
    else if (chg > 0.005) incorrect++;
    else neutral++;
  }
  return { correct, incorrect, neutral };
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

  let supabase;
  try { supabase = _getSupabase(); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  // 5 attempts per 15 minutes on this protected endpoint
  try {
    const rlKey = `${ip}:validate`;
    const now = new Date();
    const windowStart = new Date(now - 900000); // 15 min
    const { data: rlData } = await supabase.from('rate_limits').select('count, window_start').eq('key', rlKey).maybeSingle();
    if (rlData && new Date(rlData.window_start) >= windowStart && rlData.count >= 5) {
      return res.status(429).json({ error: 'Too many requests — try again in 15 minutes.' });
    }
    if (!rlData || new Date(rlData.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key: rlKey, count: 1, window_start: now.toISOString() });
    } else {
      await supabase.from('rate_limits').update({ count: rlData.count + 1 }).eq('key', rlKey);
    }
  } catch (_) { /* fail open if rate limit table unavailable */ }

  // Secret check — after rate limit so brute-force is gated first
  const secret = req.query.secret || req.headers['x-validate-secret'];
  if (process.env.VALIDATE_SECRET && secret !== process.env.VALIDATE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();

    // Fetch predictions past their validation date with no outcome yet
    const { data: pending, error: fetchErr } = await supabase
      .from('predictions')
      .select('id, topic, sources, winner_tickers, loser_tickers, baseline_prices, validation_date')
      .is('correct', null)
      .lte('validation_date', now.toISOString())
      .not('baseline_prices', 'is', null);

    if (fetchErr) throw fetchErr;

    const ready = (pending || []).filter(p =>
      (p.winner_tickers?.length || p.loser_tickers?.length) &&
      p.baseline_prices &&
      Object.keys(p.baseline_prices).length > 0
    );

    if (!ready.length) return res.status(200).json({ validated: 0, message: 'No predictions ready for validation' });

    // Fetch current prices for all relevant tickers at once
    const allTickers = [...new Set(ready.flatMap(p => [...(p.winner_tickers || []), ...(p.loser_tickers || [])]))];
    const currentPrices = await _fetchCurrentPrices(allTickers);

    let validatedCount = 0;
    const results = [];

    for (const p of ready) {
      const scores = _scoreDirections(p.winner_tickers || [], p.loser_tickers || [], p.baseline_prices, currentPrices);
      const total = scores.correct + scores.incorrect;
      if (total === 0) continue;

      const correct = scores.correct / total >= 0.6;
      const relevantPrices = Object.fromEntries(
        Object.entries(currentPrices).filter(([t]) => allTickers.includes(t) && (p.winner_tickers || []).concat(p.loser_tickers || []).includes(t))
      );

      const { error: updateErr } = await supabase
        .from('predictions')
        .update({
          correct,
          validated_at: now.toISOString(),
          actual_prices: relevantPrices,
          notes: { scores, method: 'auto' }
        })
        .eq('id', p.id);

      if (updateErr) { console.error('Update error for', p.id, updateErr.message); continue; }

      validatedCount++;
      results.push({ id: p.id, topic: p.topic, correct, scores });
    }

    return res.status(200).json({ validated: validatedCount, results });

  } catch (err) {
    console.error('[validate]', err.message);
    return res.status(500).json({ error: 'Validation run failed' });
  }
}
