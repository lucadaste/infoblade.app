import { createClient } from '@supabase/supabase-js';
import { buildContextGraph } from '../lib/context-graph.js';

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICEKEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICEKEY env vars required');
  return createClient(url, key);
}

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _parseTimeframeDays(str) {
  if (!str) return 7;
  const s = str.toLowerCase();
  const n = parseInt((s.match(/(\d+)/) || [])[1] || '1', 10);
  if (s.includes('day'))   return Math.min(n, 30);
  if (s.includes('week'))  return Math.min(n * 7, 90);
  if (s.includes('month')) return Math.min(n * 30, 365);
  return 7;
}

async function _fetchPrices(tickers, timeoutMs = 7000) {
  if (!tickers.length) return {};
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeoutMs);
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

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleSave(req, res, supabase) {
  const { topic, direction, confidence, impactTimeframe, winnerTickers, loserTickers, category } = req.body || {};
  if (!topic?.trim()) return res.status(400).json({ error: 'topic required' });

  const winners = (winnerTickers || []).filter(t => /^[A-Z.]{1,7}$/.test(t)).slice(0, 20);
  const losers  = (loserTickers  || []).filter(t => /^[A-Z.]{1,7}$/.test(t)).slice(0, 20);
  if (!winners.length && !losers.length) return res.status(400).json({ error: 'no trackable tickers' });

  const topicTrimmed = topic.trim().slice(0, 300);
  const twoHoursAgo  = new Date(Date.now() - 7200000).toISOString();

  const { count } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .eq('topic', topicTrimmed)
    .gte('created_at', twoHoursAgo);
  if (count > 0) return res.status(200).json({ ok: true, skipped: true });

  const days           = _parseTimeframeDays(impactTimeframe);
  const validationDate = new Date(Date.now() + days * 86400000).toISOString();
  const allTickers     = [...new Set([...winners, ...losers])];
  const baselinePrices = await _fetchPrices(allTickers, 6000);

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

async function handleResolve(req, res, supabase) {
  const now = new Date().toISOString();
  const { data: pending, error } = await supabase
    .from('predictions')
    .select('id, winner_tickers, loser_tickers, baseline_prices, analysis, category, sources')
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
    const actual   = await _fetchPrices(allTickers, 8000);

    const tickerMoves = {};
    let correctCount = 0, gradedCount = 0;

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
      .update({ correct, actual_prices: actual, validated_at: now, analysis: { ...(pred.analysis || {}), grade, score, ticker_moves: tickerMoves } })
      .eq('id', pred.id);

    if (!updateErr) {
      resolved++;
      const predSources = pred.sources || [];
      if (predSources.length) {
        await Promise.allSettled(predSources.map(source =>
          supabase.rpc('upsert_source_reputation', { p_source: source, p_correct: correct ? 1 : 0 })
        ));
      }
    }
  }

  return res.status(200).json({ resolved });
}

async function handleGraph(req, res, supabase) {
  const tickers = (req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(t => /^[A-Z.]{1,7}$/.test(t)).slice(0, 20);
  const category = req.query.category || null;
  try {
    const graph = await buildContextGraph(supabase, { tickers, category });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(graph ?? { overall: null, categoryAccuracy: null, tickerHistory: [], recentPredictions: [] });
  } catch (err) {
    console.error('[predictions/graph]', err.message);
    return res.status(500).json({ error: 'Failed to build context graph' });
  }
}

async function handleStats(req, res, supabase) {
  const { data: validated, error: vErr } = await supabase
    .from('predictions')
    .select('id, created_at, topic, winner_tickers, loser_tickers, correct, analysis, validation_date, validated_at, actual_prices, baseline_prices, category')
    .not('correct', 'is', null)
    .order('created_at', { ascending: false });
  if (vErr) throw vErr;

  const { count: pending, error: pErr } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .is('correct', null);
  if (pErr) throw pErr;

  const total    = validated?.length ?? 0;
  const correct  = validated?.filter(p => p.correct === true).length ?? 0;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : null;

  const { data: recent, error: rErr } = await supabase
    .from('predictions')
    .select('id, created_at, topic, winner_tickers, loser_tickers, correct, validation_date, analysis')
    .order('created_at', { ascending: false })
    .limit(20);
  if (rErr) throw rErr;

  const byMonth = {};
  for (const p of validated ?? []) {
    const month = p.created_at.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { total: 0, correct: 0 };
    byMonth[month].total++;
    if (p.correct) byMonth[month].correct++;
  }
  const timeline = Object.entries(byMonth)
    .map(([month, s]) => ({ month, total: s.total, correct: s.correct, accuracy: Math.round(s.correct / s.total * 100) }))
    .sort((a, b) => a.month.localeCompare(b.month));

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

  const tickerStats = {};
  for (const p of validated ?? []) {
    for (const t of [...new Set([...(p.winner_tickers || []), ...(p.loser_tickers || [])])]) {
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
    timeline, byCategory, topTickers,
    recent: (recent ?? []).map(p => ({
      id: p.id, topic: p.topic, createdAt: p.created_at,
      validationDate: p.validation_date, winnerTickers: p.winner_tickers,
      loserTickers: p.loser_tickers, correct: p.correct,
      confidence: p.analysis?.confidence || null,
      impactTimeframe: p.analysis?.impact_timeframe || null,
      grade: p.analysis?.grade || null, score: p.analysis?.score ?? null,
      tickerMoves: p.analysis?.ticker_moves || null,
    }))
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let supabase;
  try { supabase = _getSupabase(); } catch (e) {
    return res.status(500).json({ error: 'Database configuration error', detail: e.message });
  }

  try {
    if (req.method === 'POST')                    return await handleSave(req, res, supabase);
    if (req.query.resolve === 'true')             return await handleResolve(req, res, supabase);
    if (req.query.graph   === 'true')             return await handleGraph(req, res, supabase);
    if (req.method === 'GET')                     return await handleStats(req, res, supabase);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[predictions]', err.message);
    return res.status(500).json({ error: 'Failed to load predictions' });
  }
}
