import { createClient } from '@supabase/supabase-js';
import { buildContextGraph } from '../lib/context-graph.js';

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

// ── Shared helpers ────────────────────────────────────────────────────────────

// Map prediction categories to the 3 public-facing sections
const _SECTION_CATS = {
  stocks:              new Set(['any','technology','macro','energy','financials','precious-metals','real-estate','consumer','healthcare','defense','etfs','stock']),
  crypto:              new Set(['crypto']),
  'prediction-markets': new Set(['prediction-markets','politics','sports','entertainment','finance','tech']),
};
const _SECTION_LABELS = { stocks: 'Stock Markets', crypto: 'Crypto', 'prediction-markets': 'Prediction Markets' };

function _categoryToSection(cat) {
  for (const [s, cats] of Object.entries(_SECTION_CATS)) { if (cats.has(cat)) return s; }
  return 'stocks';
}

function _sectionStats(preds) {
  const map = {};
  for (const p of preds) {
    const sec = _categoryToSection(p.category || 'any');
    if (!map[sec]) map[sec] = { total: 0, correct: 0, scoreSum: 0, scoreCount: 0 };
    map[sec].total++;
    if (p.correct) map[sec].correct++;
    const s = p.analysis?.accuracy_score ?? p.analysis?.score ?? null;
    if (s != null) { map[sec].scoreSum += s; map[sec].scoreCount++; }
  }
  return Object.entries(_SECTION_LABELS).map(([sec, label]) => {
    const d = map[sec] || { total: 0, correct: 0, scoreSum: 0, scoreCount: 0 };
    return {
      section:  sec,
      label,
      total:    d.total,
      correct:  d.correct,
      accuracy: d.total > 0 ? Math.round(d.correct / d.total * 100) : null,
      avgScore: d.scoreCount > 0 ? +(d.scoreSum / d.scoreCount).toFixed(1) : null,
    };
  });
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

// Fetch closing price on a specific date via Yahoo Finance v8 chart API.
// Used for retroactive validation — gets the actual price at the end of the prediction timeframe.
async function _fetchPriceOnDate(symbol, targetDate) {
  const dayMs = 86400000;
  const p1 = Math.floor((targetDate.getTime() - 4 * dayMs) / 1000); // 4 days before (weekend buffer)
  const p2 = Math.floor((targetDate.getTime() + 2 * dayMs) / 1000); // 2 days after
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const tss    = result.timestamps || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    if (!tss.length) return null;
    // Find the trading day closest to targetDate
    const targetTs = targetDate.getTime() / 1000;
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < tss.length; i++) {
      if (closes[i] == null) continue;
      const diff = Math.abs(tss[i] - targetTs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return bestIdx >= 0 ? +closes[bestIdx].toFixed(4) : null;
  } catch (_) { return null; }
}

// Get actual prices for a prediction — uses historical price at validation_date for late resolutions.
async function _resolveActualPrices(pred, currentPriceMap) {
  const validationDate = new Date(pred.validation_date);
  const daysSince = (Date.now() - validationDate.getTime()) / 86400000;
  // If validation date passed more than 2 days ago, use historical prices for accuracy
  if (daysSince <= 2) return currentPriceMap;

  const allTickers = [...new Set([...(pred.winner_tickers || []), ...(pred.loser_tickers || [])])];
  const historicalPrices = {};
  await Promise.allSettled(
    allTickers.map(async t => {
      const p = await _fetchPriceOnDate(t, validationDate);
      if (p != null) historicalPrices[t] = p;
    })
  );
  // Merge: historical takes priority, fall back to current if unavailable
  return { ...currentPriceMap, ...historicalPrices };
}

function _tickerScore(pct, direction) {
  const signed = direction === 'bullish' ? pct : -pct;
  return +(Math.max(-100, Math.min(100, signed * 10)).toFixed(1));
}

function _letterGrade(score) {
  if (score >= 70)  return 'A';
  if (score >= 40)  return 'B';
  if (score >= 5)   return 'C';
  if (score >= -20) return 'D';
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
  const nowStr = new Date().toISOString();
  const nowMs  = Date.now();

  // Fetch ALL unresolved predictions — no filter on validation_date or baseline_prices
  // so we handle legacy predictions that were saved without those fields.
  const { data: all, error } = await supabase
    .from('predictions')
    .select('id, created_at, validation_date, winner_tickers, loser_tickers, baseline_prices, analysis, category, sources')
    .is('correct', null)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return res.status(500).json({ error: error.message });
  if (!all?.length) return res.status(200).json({ resolved: 0, total: 0 });

  // Determine effective validation date for each prediction (derive if missing)
  const ready = all
    .map(p => {
      let vDate = p.validation_date ? new Date(p.validation_date) : null;
      if (!vDate && p.created_at) {
        const days = _parseTimeframeDays(p.analysis?.impact_timeframe);
        vDate = new Date(new Date(p.created_at).getTime() + days * 86400000);
      }
      return { ...p, _vDate: vDate };
    })
    .filter(p =>
      p._vDate && p._vDate.getTime() <= nowMs &&  // timeframe has expired
      ((p.winner_tickers?.length || 0) + (p.loser_tickers?.length || 0)) > 0
    );

  if (!ready.length) return res.status(200).json({ resolved: 0, total: all.length, skipped: all.length });

  // ── Build a cache of (ticker, dateKey) → price to avoid duplicate API calls ──
  const priceCache = new Map(); // key: "TICKER::YYYY-MM-DD"

  async function _cachedPrice(ticker, date) {
    const key = `${ticker}::${date.toISOString().slice(0, 10)}`;
    if (priceCache.has(key)) return priceCache.get(key);
    const p = await _fetchPriceOnDate(ticker, date);
    priceCache.set(key, p);
    return p;
  }

  // Pre-warm cache in parallel for all unique (ticker, baselineDate, validationDate) combos
  const lookups = new Set();
  for (const p of ready) {
    const baseDate = new Date(p.created_at);
    for (const t of [...(p.winner_tickers || []), ...(p.loser_tickers || [])]) {
      if (!p.baseline_prices?.[t]) lookups.add(`${t}::${baseDate.toISOString().slice(0, 10)}`);
      lookups.add(`${t}::${p._vDate.toISOString().slice(0, 10)}`);
    }
  }

  await Promise.allSettled(
    [...lookups].map(key => {
      const [ticker, dateStr] = key.split('::');
      if (priceCache.has(key)) return;
      return _fetchPriceOnDate(ticker, new Date(dateStr)).then(p => priceCache.set(key, p));
    })
  );

  // ── Score each prediction ──────────────────────────────────────────────────
  let resolved = 0, skipped = 0;
  const updates = [];

  for (const pred of ready) {
    const winners    = (pred.winner_tickers || []).filter(t => /^[A-Z.]{1,7}$/.test(t));
    const losers     = (pred.loser_tickers  || []).filter(t => /^[A-Z.]{1,7}$/.test(t));
    const allTickers = [...new Set([...winners, ...losers])];

    const baseDate = new Date(pred.created_at);
    const valDate  = pred._vDate;

    // Build baseline: use stored value or fall back to historical price at created_at
    const baseline = { ...(pred.baseline_prices || {}) };
    for (const t of allTickers) {
      if (!baseline[t]) {
        const hp = priceCache.get(`${t}::${baseDate.toISOString().slice(0, 10)}`);
        if (hp != null) baseline[t] = hp;
      }
    }

    // Actual prices at validation_date
    const actual = {};
    for (const t of allTickers) {
      const hp = priceCache.get(`${t}::${valDate.toISOString().slice(0, 10)}`);
      if (hp != null) actual[t] = hp;
    }

    const tickerMoves = {};
    for (const t of winners) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const pts = _tickerScore(pct, 'bullish');
      tickerMoves[t] = { pct, direction: 'bullish', correct: pct >= 0.5, pts, basePrice: baseline[t], actualPrice: actual[t] };
    }
    for (const t of losers) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const pts = _tickerScore(pct, 'bearish');
      tickerMoves[t] = { pct, direction: 'bearish', correct: pct <= -0.5, pts, basePrice: baseline[t], actualPrice: actual[t] };
    }

    if (!Object.keys(tickerMoves).length) { skipped++; continue; }

    const tickerScores  = Object.values(tickerMoves).map(m => m.pts);
    const accuracyScore = +(tickerScores.reduce((a, b) => a + b, 0) / tickerScores.length).toFixed(1);
    const correct = accuracyScore > 0;
    const grade   = _letterGrade(accuracyScore);

    updates.push({
      id:              pred.id,
      correct,
      validated_at:    nowStr,
      validation_date: valDate.toISOString(), // persist derived date
      baseline_prices: baseline,              // persist filled-in baseline
      actual_prices:   actual,
      analysis:        { ...(pred.analysis || {}), grade, score: accuracyScore, accuracy_score: accuracyScore, ticker_moves: tickerMoves },
      sources:         pred.sources,
    });
  }

  // ── Apply updates in parallel ──────────────────────────────────────────────
  await Promise.allSettled(updates.map(async u => {
    const { error: updateErr } = await supabase
      .from('predictions')
      .update({
        correct:         u.correct,
        validated_at:    u.validated_at,
        validation_date: u.validation_date,
        baseline_prices: u.baseline_prices,
        actual_prices:   u.actual_prices,
        analysis:        u.analysis,
      })
      .eq('id', u.id);

    if (!updateErr) {
      resolved++;
      if (u.sources?.length) {
        await Promise.allSettled(u.sources.map(src =>
          supabase.rpc('upsert_source_reputation', { p_source: src, p_correct: u.correct ? 1 : 0 })
        ));
      }
    }
  }));

  return res.status(200).json({ resolved, skipped, total: all.length });
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

  // Resolve user identity if auth token provided
  let userId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { data: { user } } = await supabase.auth.getUser(authHeader.slice(7));
      userId = user?.id ?? null;
    } catch (_) {}
  }

  const { count: pendingCount, error: pErr } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .is('correct', null);
  if (pErr) throw pErr;
  const pending = pendingCount;

  const { count: totalInDb } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true });

  const total    = validated?.length ?? 0;
  const correct  = validated?.filter(p => p.correct === true).length ?? 0;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : null;
  const scores   = (validated || []).map(p => p.analysis?.accuracy_score ?? p.analysis?.score ?? null).filter(s => s != null);
  const avgScore = scores.length > 0 ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;

  const { data: recent, error: rErr } = await supabase
    .from('predictions')
    .select('id, created_at, topic, winner_tickers, loser_tickers, correct, validation_date, analysis')
    .order('created_at', { ascending: false })
    .limit(20);
  if (rErr) throw rErr;

  const byMonth = {};
  for (const p of validated ?? []) {
    const month = p.created_at.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { total: 0, correct: 0, scoreSum: 0, scoreCount: 0 };
    byMonth[month].total++;
    if (p.correct) byMonth[month].correct++;
    const s = p.analysis?.accuracy_score ?? p.analysis?.score ?? null;
    if (s != null) { byMonth[month].scoreSum += s; byMonth[month].scoreCount++; }
  }
  const timeline = Object.entries(byMonth)
    .map(([month, s]) => ({
      month,
      total:    s.total,
      correct:  s.correct,
      accuracy: Math.round(s.correct / s.total * 100),
      avgScore: s.scoreCount > 0 ? +(s.scoreSum / s.scoreCount).toFixed(1) : null,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Cumulative score timeline (running total of accuracy points, oldest-first)
  const validatedAsc = [...(validated ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let cumulative = 0;
  const cumulativeTimeline = validatedAsc.map(p => {
    const s = p.analysis?.accuracy_score ?? p.analysis?.score ?? 0;
    cumulative = +(cumulative + s).toFixed(1);
    return { date: p.created_at.slice(0, 10), cumulative };
  });

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
    .filter(([, s]) => s.total >= 1)
    .map(([ticker, s]) => ({ ticker, winRate: Math.round(s.wins / s.total * 100), total: s.total }))
    .sort((a, b) => b.total - a.total || b.winRate - a.winRate)
    .slice(0, 15);

  // Per-section breakdown (Stocks / Crypto / Prediction Markets)
  const bySection = _sectionStats(validated ?? []);

  // User-specific stats (only when authenticated)
  let userStats = null;
  if (userId) {
    const { data: userPreds, error: uErr } = await supabase
      .from('predictions')
      .select('id, created_at, topic, winner_tickers, loser_tickers, correct, analysis, validation_date, category')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!uErr && userPreds) {
      const uValidated = userPreds.filter(p => p.correct !== null);
      const uTotal   = uValidated.length;
      const uCorrect = uValidated.filter(p => p.correct).length;
      const uScores  = uValidated.map(p => p.analysis?.accuracy_score ?? p.analysis?.score ?? null).filter(s => s != null);
      userStats = {
        summary: {
          total:    uTotal,
          correct:  uCorrect,
          pending:  userPreds.filter(p => p.correct === null).length,
          accuracy: uTotal > 0 ? Math.round(uCorrect / uTotal * 100) : null,
          avgScore: uScores.length > 0 ? +(uScores.reduce((a, b) => a + b, 0) / uScores.length).toFixed(1) : null,
        },
        bySection: _sectionStats(uValidated),
        recent: userPreds.map(p => ({
          id: p.id, topic: p.topic, createdAt: p.created_at,
          validationDate: p.validation_date, winnerTickers: p.winner_tickers,
          loserTickers: p.loser_tickers, correct: p.correct,
          confidence: p.analysis?.confidence || null,
          impactTimeframe: p.analysis?.impact_timeframe || null,
          grade: p.analysis?.grade || null,
          score: p.analysis?.accuracy_score ?? p.analysis?.score ?? null,
          tickerMoves: p.analysis?.ticker_moves || null,
          category: p.category,
        })),
      };
    }
  }

  return res.status(200).json({
    summary: { total, correct, incorrect: total - correct, accuracy, avgScore, pending: pending ?? 0, totalInDb: totalInDb ?? 0 },
    timeline, cumulativeTimeline, bySection, byCategory, topTickers,
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
