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

function _sectionStats(preds, pendingBySection = {}) {
  const map = {};
  for (const p of preds) {
    const sec = _categoryToSection(p.category || 'any');
    if (!map[sec]) map[sec] = { lenientCorrect: 0, total: 0 };
    const score = p.analysis?.accuracy_score ?? p.analysis?.score ?? -100;
    map[sec].total++;
    if (score > -15) map[sec].lenientCorrect++;
  }
  return Object.entries(_SECTION_LABELS).map(([sec, label]) => {
    const d = map[sec] || { lenientCorrect: 0, total: 0 };
    return {
      section:  sec,
      label,
      total:    d.total,
      pending:  pendingBySection[sec] || 0,
      accuracy: d.total > 0 ? Math.round(d.lenientCorrect / d.total * 100) : null,
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

// Fetch the FULL daily price history for a ticker over a date range in ONE request.
// Returns a map of { "YYYY-MM-DD": closePrice } covering all trading days in the range.
async function _fetchTickerHistory(ticker, startMs, endMs) {
  const p1 = Math.floor(startMs / 1000) - 7 * 86400; // 1 week buffer before
  const p2 = Math.floor(endMs   / 1000) + 7 * 86400; // 1 week buffer after
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${p1}&period2=${p2}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return {};
    const tss    = result.timestamp || result.timestamps || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const map    = {};
    for (let i = 0; i < tss.length; i++) {
      if (closes[i] == null) continue;
      map[new Date(tss[i] * 1000).toISOString().slice(0, 10)] = +closes[i].toFixed(4);
    }
    return map;
  } catch (_) { return {}; }
}

// Look up the price closest to targetDate in a pre-fetched history map.
// Returns null if no price within 5 trading days (7 calendar days).
function _priceOnDate(historyMap, targetDate) {
  const keys = Object.keys(historyMap);
  if (!keys.length) return null;
  const targetMs = targetDate.getTime();
  let best = null, bestDiff = Infinity;
  for (const k of keys) {
    const diff = Math.abs(new Date(k).getTime() - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = k; }
  }
  return bestDiff <= 7 * 86400000 ? historyMap[best] : null;
}

function _tickerScore(pct, direction) {
  const signed = direction === 'bullish' ? pct : -pct;
  return +(Math.max(-100, Math.min(100, signed * 10)).toFixed(1));
}

// Parse confidence stars (1-5) from stored string e.g. "4 — strong signal"
function _parseConfidenceStars(conf) {
  if (!conf) return 3;
  const m = String(conf).match(/^\s*([1-5])/);
  return m ? parseInt(m[1]) : 3;
}

function _letterGrade(score) {
  if (score >= 60)  return 'A';
  if (score >= 25)  return 'B';
  if (score >= 0)   return 'C';
  if (score >= -25) return 'D';
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

  // ── 1. Fetch all unresolved predictions ──────────────────────────────────────
  const { data: all, error } = await supabase
    .from('predictions')
    .select('id, created_at, validation_date, winner_tickers, loser_tickers, baseline_prices, analysis, category, sources, lean, lean_confidence, market_slug')
    .is('correct', null)
    .order('created_at', { ascending: true })
    .limit(1000);

  if (error) return res.status(500).json({ error: error.message });
  if (!all?.length) return res.status(200).json({ resolved: 0, total: 0 });

  // ── 2. Derive effective validation date for each; keep only expired ones ───
  const ready = [];
  for (const p of all) {
    if (!p.winner_tickers?.length && !p.loser_tickers?.length) continue;
    let vDate = p.validation_date ? new Date(p.validation_date) : null;
    if (!vDate && p.created_at) {
      const days = _parseTimeframeDays(p.analysis?.impact_timeframe);
      vDate = new Date(new Date(p.created_at).getTime() + days * 86400000);
    }
    if (!vDate || vDate.getTime() > nowMs) continue; // not expired yet
    ready.push({ ...p, _vDate: vDate });
  }

  if (!ready.length) return res.status(200).json({ resolved: 0, total: all.length, pending: all.length });

  // ── 3. Collect unique tickers and the overall date range ──────────────────
  const uniqueTickers = new Set();
  let minMs = nowMs, maxMs = 0;
  for (const p of ready) {
    for (const t of [...(p.winner_tickers || []), ...(p.loser_tickers || [])]) {
      if (/^[A-Z^.]{1,7}$/.test(t)) uniqueTickers.add(t);
    }
    const createdMs = new Date(p.created_at).getTime();
    if (createdMs < minMs) minMs = createdMs;
    if (p._vDate.getTime() > maxMs) maxMs = p._vDate.getTime();
  }

  // ── 4. ONE history fetch per ticker covering the full date range ───────────
  //    Batched in groups of 5 to avoid Yahoo Finance rate limiting.
  const histories = {}; // { ticker: { "YYYY-MM-DD": price } }
  const tickerList = [...uniqueTickers];
  for (let i = 0; i < tickerList.length; i += 5) {
    const chunk = tickerList.slice(i, i + 5);
    await Promise.all(chunk.map(async t => {
      histories[t] = await _fetchTickerHistory(t, minMs, maxMs);
    }));
    if (i + 5 < tickerList.length) await new Promise(r => setTimeout(r, 300));
  }

  // ── 5. Score every prediction from the cached history ─────────────────────
  const updates = [];
  let skipped = 0;

  for (const pred of ready) {
    const winners    = (pred.winner_tickers || []).filter(t => histories[t]);
    const losers     = (pred.loser_tickers  || []).filter(t => histories[t]);
    if (!winners.length && !losers.length) { skipped++; continue; }

    const createdDate = new Date(pred.created_at);
    const valDate     = pred._vDate;

    // Build baseline: stored price preferred; fall back to price at created_at from history
    const baseline = { ...(pred.baseline_prices || {}) };
    for (const t of [...winners, ...losers]) {
      if (!baseline[t] && histories[t]) {
        const p = _priceOnDate(histories[t], createdDate);
        if (p != null) baseline[t] = p;
      }
    }

    // Actual price: price at the validation date from history
    const actual = {};
    for (const t of [...winners, ...losers]) {
      if (histories[t]) {
        const p = _priceOnDate(histories[t], valDate);
        if (p != null) actual[t] = p;
      }
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
    const hitCount      = Object.values(tickerMoves).filter(m => m.correct).length;
    const hitRate       = tickerScores.length > 0 ? hitCount / tickerScores.length : 0;
    const hitBonus      = +((hitRate - 0.5) * 20).toFixed(1); // -10 to +10 pts: rewards getting direction right on more tickers
    const avgScore      = +(tickerScores.reduce((a, b) => a + b, 0) / tickerScores.length).toFixed(1);
    const accuracyScore = +(avgScore + hitBonus).toFixed(1);
    const correct       = accuracyScore > 0;
    const grade         = _letterGrade(accuracyScore);
    const confidence_weight  = _parseConfidenceStars(pred.analysis?.confidence);

    updates.push({
      id: pred.id, correct,
      validated_at:    nowStr,
      validation_date: valDate.toISOString(),
      baseline_prices: baseline,
      actual_prices:   actual,
      analysis: { ...(pred.analysis || {}), grade, score: accuracyScore, accuracy_score: accuracyScore, confidence_weight, ticker_moves: tickerMoves },
      sources: pred.sources,
    });
  }

  // ── 6. Write results to DB in parallel chunks of 50 ───────────────────────
  let resolved = 0;
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.allSettled(
      updates.slice(i, i + CHUNK).map(async u => {
        const { error: e } = await supabase
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
        if (!e) {
          resolved++;
          if (u.sources?.length) {
            await Promise.allSettled(u.sources.map(src =>
              supabase.rpc('upsert_source_reputation', { p_source: src, p_correct: u.correct ? 1 : 0 })
            ));
          }
        }
      })
    );
  }

  // ── 7. Prediction market resolution (Polymarket) ─────────────────────────
  const pmReady = all.filter(p => {
    if (p.correct !== null) return false;
    const lean = p.lean || p.analysis?.lean;
    if (lean !== 'Yes' && lean !== 'No') return false;
    const vDate = p.validation_date ? new Date(p.validation_date) : null;
    const ageMs = nowMs - new Date(p.created_at).getTime();
    return vDate ? vDate.getTime() <= nowMs : ageMs > 30 * 86400000;
  });

  for (const pred of pmReady) {
    const lean     = pred.lean || pred.analysis?.lean;
    const confStr  = pred.lean_confidence || pred.analysis?.lean_confidence || 'Low';
    const slug     = pred.market_slug;
    if (!slug) continue; // can't look up without a slug

    try {
      const r = await fetch(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) continue;
      const events = await r.json();
      const event  = Array.isArray(events) ? events[0] : events;
      if (!event?.closed) continue;
      const market = (event.markets || [])[0];
      if (!market?.resolved) continue;

      let prices;
      try { prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices; }
      catch (_) { continue; }
      if (!Array.isArray(prices) || prices.length < 2) continue;

      const yesPrice = parseFloat(prices[0]);
      const outcome  = yesPrice >= 0.99 ? 'Yes' : yesPrice <= 0.01 ? 'No' : null;
      if (!outcome) continue;

      const leanCorrect = lean === outcome;
      const baseScore   = leanCorrect ? 50 : -50;
      const confBonus   = confStr === 'High' ? 15 : confStr === 'Medium' ? 7 : 0;
      const accuracyScore = +(baseScore + (leanCorrect ? confBonus : -confBonus)).toFixed(1);
      const pmGrade     = _letterGrade(accuracyScore);

      const { error: pmErr } = await supabase
        .from('predictions')
        .update({
          correct:      accuracyScore > 0,
          validated_at: nowStr,
          analysis:     {
            ...(pred.analysis || {}),
            grade: pmGrade, score: accuracyScore, accuracy_score: accuracyScore,
            resolved_outcome: outcome, lean_was: lean,
          },
        })
        .eq('id', pred.id);
      if (!pmErr) resolved++;
    } catch (_) { /* skip on network error, retry next pass */ }
  }

  // ── 8. Retroactive crypto category fix ───────────────────────────────────
  // Crypto predictions saved before category:'crypto' was added to crypto.html
  // were stored with category=null. Fix them so they appear under Crypto section stats.
  {
    const cryptoRx = /\b(bitcoin|ethereum|solana|avalanche|cardano|polkadot|dogecoin|ripple|\bbtc\b|\beth\b|\bbnb\b|\bxrp\b|\bsol\b|crypto(?:currency)?|defi|blockchain|altcoin|coinbase.*price|coin.*price|nft market)\b/i;
    const { data: uncat } = await supabase
      .from('predictions')
      .select('id, topic')
      .is('category', null)
      .limit(1000);
    const cryptoIds = (uncat || []).filter(p => cryptoRx.test(p.topic || '')).map(p => p.id);
    if (cryptoIds.length) {
      for (let i = 0; i < cryptoIds.length; i += 50) {
        await supabase.from('predictions').update({ category: 'crypto' }).in('id', cryptoIds.slice(i, i + 50));
      }
    }
  }

  // ── 9. Retroactive PM grading via Polymarket text search ─────────────────
  // For PM predictions stored without a market_slug (before we fixed the slug storage),
  // attempt fuzzy word-overlap matching against recently-closed Polymarket events.
  {
    const pmNoSlug = all.filter(p =>
      (p.lean || p.analysis?.lean) && !p.market_slug && p.correct === null
    );

    if (pmNoSlug.length > 0) {
      // Fetch recently closed Polymarket events
      let closedEvents = [];
      try {
        const r = await fetch(
          'https://gamma-api.polymarket.com/events?closed=true&limit=500&order=end_date&ascending=false',
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) }
        );
        if (r.ok) closedEvents = await r.json();
      } catch (_) {}

      const _PM_STOPS = new Set([
        'will','does','the','this','that','for','with','not','its','has','from',
        'been','have','which','their','more','most','just','also','over','after',
        'when','what','who','would','could','should','these','those','they','them',
        'into','about','before','during','between','going','than','very','too',
      ]);

      function _pmWordScore(q, title) {
        const qWords = q.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/)
          .filter(w => w.length > 2 && !_PM_STOPS.has(w));
        if (!qWords.length) return 0;
        const tWords = new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/));
        return qWords.filter(w => tWords.has(w)).length / qWords.length;
      }

      let pmTextMatched = 0;
      for (const pred of pmNoSlug) {
        const question = pred.topic || '';
        let bestEvent = null, bestScore = 0;

        for (const event of Array.isArray(closedEvents) ? closedEvents : []) {
          const s = _pmWordScore(question, event.title || '');
          if (s > bestScore) { bestScore = s; bestEvent = event; }
        }
        // Require 55% word overlap to avoid false matches
        if (bestScore < 0.55 || !bestEvent) continue;

        const market = (bestEvent.markets || [])[0];
        if (!market?.resolved) continue;

        let prices;
        try {
          prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
        } catch (_) { continue; }
        if (!Array.isArray(prices) || prices.length < 2) continue;

        const yesPrice = parseFloat(prices[0]);
        const outcome = yesPrice >= 0.99 ? 'Yes' : yesPrice <= 0.01 ? 'No' : null;
        if (!outcome) continue;

        const lean      = pred.lean || pred.analysis?.lean;
        const confStr   = pred.lean_confidence || pred.analysis?.lean_confidence || 'Low';
        const correct   = lean === outcome;
        const baseScore = correct ? 50 : -50;
        const confBonus = confStr === 'High' ? 15 : confStr === 'Medium' ? 7 : 0;
        const accScore  = +(baseScore + (correct ? confBonus : -confBonus)).toFixed(1);

        const { error: pmErr2 } = await supabase
          .from('predictions')
          .update({
            correct:      accScore > 0,
            validated_at: nowStr,
            market_slug:  bestEvent.slug || null,
            analysis: {
              ...(pred.analysis || {}),
              grade: _letterGrade(accScore),
              score: accScore,
              accuracy_score: accScore,
              resolved_outcome: outcome,
              lean_was: lean,
              text_match_pct: Math.round(bestScore * 100),
            },
          })
          .eq('id', pred.id);
        if (!pmErr2) { resolved++; pmTextMatched++; }
      }
    }
  }

  return res.status(200).json({ resolved, skipped, total: all.length, ready: ready.length, pmChecked: pmReady.length });
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

  const total = validated?.length ?? 0;

  // Confidence-weighted accuracy: high-confidence correct predictions count more
  let weightedCorrect = 0, totalWeight = 0;
  for (const p of validated ?? []) {
    const w = p.analysis?.confidence_weight ?? _parseConfidenceStars(p.analysis?.confidence);
    totalWeight    += w;
    if (p.correct) weightedCorrect += w;
  }
  const correct  = validated?.filter(p => p.correct === true).length ?? 0;
  const accuracy = totalWeight > 0 ? Math.round(weightedCorrect / totalWeight * 100) : null;

  // Lenient accuracy: predictions with score > -15 are directionally meaningful
  // (removes the strict 0.5% movement threshold for borderline cases)
  const lenientCorrect = (validated ?? []).filter(p =>
    (p.analysis?.accuracy_score ?? p.analysis?.score ?? -100) > -15
  ).length;
  const displayAccuracy = total >= 5 ? Math.round(lenientCorrect / total * 100) : null;

  // Fetch all resolved predictions (up to 500 covers full history) + recent pending separately
  // so that filtering "Correct" or "Incorrect" in the UI shows the full dataset, not just
  // the most recent 50 by creation date (which are almost all pending).
  const [{ data: resolvedAll, error: rErr }, { data: pendingRecent }] = await Promise.all([
    supabase
      .from('predictions')
      .select('id, created_at, topic, winner_tickers, loser_tickers, correct, validation_date, analysis, category, lean, signal')
      .not('correct', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('predictions')
      .select('id, created_at, topic, winner_tickers, loser_tickers, correct, validation_date, analysis, category, lean, signal')
      .is('correct', null)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);
  if (rErr) throw rErr;
  // Resolved first (sorted newest-first), then pending at the top since they're active
  const recent = [...(pendingRecent || []), ...(resolvedAll || [])];

  const byMonth = {};
  for (const p of validated ?? []) {
    const month = p.created_at.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { weightedCorrect: 0, totalWeight: 0, total: 0, correct: 0 };
    const w = p.analysis?.confidence_weight ?? _parseConfidenceStars(p.analysis?.confidence);
    byMonth[month].total++;
    byMonth[month].totalWeight += w;
    if (p.correct) { byMonth[month].correct++; byMonth[month].weightedCorrect += w; }
  }
  const timeline = Object.entries(byMonth)
    .map(([month, s]) => ({
      month,
      total:    s.total,
      correct:  s.correct,
      accuracy: s.totalWeight > 0 ? Math.round(s.weightedCorrect / s.totalWeight * 100) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Cumulative weighted score timeline (running total, oldest-first)
  const validatedAsc = [...(validated ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let cumulative = 0;
  const cumulativeTimeline = validatedAsc.map(p => {
    const s = p.analysis?.accuracy_score ?? p.analysis?.score ?? 0;
    const w = p.analysis?.confidence_weight ?? _parseConfidenceStars(p.analysis?.confidence);
    // Weighted: high-confidence predictions move the needle more
    cumulative = +(cumulative + s * w / 3).toFixed(1); // divide by 3 (avg weight) to keep scale
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
    .filter(([, s]) => s.total >= 2)
    .map(([ticker, s]) => ({ ticker, winRate: Math.round(s.wins / s.total * 100), total: s.total }))
    .sort((a, b) => b.winRate - a.winRate || b.total - a.total)
    .slice(0, 15);

  // Pending counts by section (for sections with no resolved data yet)
  const pendingBySection = {};
  const { data: pendingAll } = await supabase
    .from('predictions')
    .select('id, category, lean')
    .is('correct', null);
  for (const p of pendingAll || []) {
    const sec = (p.lean) ? 'prediction-markets' : _categoryToSection(p.category || 'any');
    pendingBySection[sec] = (pendingBySection[sec] || 0) + 1;
  }

  // Per-section breakdown (Stocks / Crypto / Prediction Markets)
  const bySection = _sectionStats(validated ?? [], pendingBySection);

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
      let uWeightedCorrect = 0, uTotalWeight = 0;
      for (const p of uValidated) {
        const w = p.analysis?.confidence_weight ?? _parseConfidenceStars(p.analysis?.confidence);
        uTotalWeight    += w;
        if (p.correct) uWeightedCorrect += w;
      }
      userStats = {
        summary: {
          total:    uTotal,
          correct:  uCorrect,
          pending:  userPreds.filter(p => p.correct === null).length,
          accuracy: uTotalWeight > 0 ? Math.round(uWeightedCorrect / uTotalWeight * 100) : null,
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
    summary: { total, correct, incorrect: total - correct, accuracy, displayAccuracy, pending: pending ?? 0, totalInDb: totalInDb ?? 0 },
    timeline, cumulativeTimeline, bySection, byCategory, topTickers,
    recent: (recent ?? []).map(p => ({
      id: p.id, topic: p.topic, createdAt: p.created_at,
      validationDate: p.validation_date, winnerTickers: p.winner_tickers,
      loserTickers: p.loser_tickers, correct: p.correct,
      confidence: p.analysis?.confidence || null,
      impactTimeframe: p.analysis?.impact_timeframe || null,
      grade: p.analysis?.grade || null,
      score: p.analysis?.accuracy_score ?? p.analysis?.score ?? null,
      tickerMoves: p.analysis?.ticker_moves || null,
      category: p.category,
      lean: p.lean || p.analysis?.lean || null,
      signal: p.signal || p.analysis?.signal || null,
      analysis: { resolved_outcome: p.analysis?.resolved_outcome || null },
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
