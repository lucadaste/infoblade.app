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

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let supabase;
  try { supabase = _getSupabase(); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  try {
    // Validated predictions
    const { data: validated, error: vErr } = await supabase
      .from('predictions')
      .select('id, created_at, topic, winner_tickers, loser_tickers, correct, analysis, validation_date, validated_at, actual_prices, baseline_prices, category')
      .not('correct', 'is', null)
      .order('created_at', { ascending: false });
    if (vErr) throw vErr;

    // Count of pending predictions
    const { count: pending, error: pErr } = await supabase
      .from('predictions')
      .select('id', { count: 'exact', head: true })
      .is('correct', null);
    if (pErr) throw pErr;

    const total    = validated?.length ?? 0;
    const correct  = validated?.filter(p => p.correct === true).length ?? 0;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : null;

    // Most recent 20 predictions (any state)
    const { data: recent, error: rErr } = await supabase
      .from('predictions')
      .select('id, created_at, topic, winner_tickers, loser_tickers, correct, validation_date, analysis')
      .order('created_at', { ascending: false })
      .limit(20);
    if (rErr) throw rErr;

    // Accuracy by month
    const byMonth = {};
    for (const p of validated ?? []) {
      const month = p.created_at.slice(0, 7); // "YYYY-MM"
      if (!byMonth[month]) byMonth[month] = { total: 0, correct: 0 };
      byMonth[month].total++;
      if (p.correct) byMonth[month].correct++;
    }
    const timeline = Object.entries(byMonth)
      .map(([month, s]) => ({ month, total: s.total, correct: s.correct, accuracy: Math.round(s.correct / s.total * 100) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Accuracy by category — independent score per sector/topic
    const byCategoryMap = {};
    for (const p of validated ?? []) {
      const cat = p.category || null;
      if (!cat) continue;
      if (!byCategoryMap[cat]) byCategoryMap[cat] = { total: 0, correct: 0 };
      byCategoryMap[cat].total++;
      if (p.correct) byCategoryMap[cat].correct++;
    }
    const byCategory = Object.entries(byCategoryMap)
      .filter(([, s]) => s.total >= 2)
      .map(([cat, s]) => ({ category: cat, total: s.total, correct: s.correct, accuracy: Math.round(s.correct / s.total * 100) }))
      .sort((a, b) => b.total - a.total);

    // Top tickers by win rate (min 3 appearances)
    const tickerStats = {};
    for (const p of validated ?? []) {
      for (const t of p.winner_tickers || []) {
        if (!tickerStats[t]) tickerStats[t] = { wins: 0, total: 0 };
        tickerStats[t].total++;
        if (p.correct) tickerStats[t].wins++;
      }
    }
    const topTickers = Object.entries(tickerStats)
      .filter(([, s]) => s.total >= 3)
      .map(([ticker, s]) => ({ ticker, winRate: Math.round(s.wins / s.total * 100), total: s.total }))
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10);

    return res.status(200).json({
      summary: { total, correct, incorrect: total - correct, accuracy, pending: pending ?? 0 },
      timeline,
      byCategory,
      topTickers,
      recent: (recent ?? []).map(p => ({
        id: p.id,
        topic: p.topic,
        createdAt: p.created_at,
        validationDate: p.validation_date,
        winnerTickers: p.winner_tickers,
        loserTickers: p.loser_tickers,
        correct: p.correct,
        confidence: p.analysis?.confidence || null,
        impactTimeframe: p.analysis?.impact_timeframe || null,
      }))
    });

  } catch (err) {
    console.error('[predictions]', err.message);
    return res.status(500).json({ error: 'Failed to load predictions' });
  }
}
