import { createClient } from '@supabase/supabase-js';
import { buildContextGraph } from '../lib/context-graph.js';
import { getClerkUser } from '../lib/auth.js';

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
  crypto:              new Set(['crypto-coin']),
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

const _COIN_SYMS = new Set(['BTC','ETH','SOL','DOGE','XRP','AVAX','SHIB','LINK','POL','ADA','DOT','NEAR','ATOM','XLM','LTC','ALGO','UNI','AAVE','MKR','GRT','FIL','HBAR','ETC','BCH','OP','ARB','SUI','APT','PEPE','BAT','MANA','SAND','MATIC']);

// Fetch the FULL daily price history for a ticker over a date range in ONE request.
// Returns a map of { "YYYY-MM-DD": closePrice } covering all trading days in the range.
async function _fetchTickerHistory(ticker, startMs, endMs) {
  const p1 = Math.floor(startMs / 1000) - 7 * 86400; // 1 week buffer before
  const p2 = Math.floor(endMs   / 1000) + 7 * 86400; // 1 week buffer after
  const yTicker = _COIN_SYMS.has(ticker) ? `${ticker}-USD` : ticker;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?interval=1d&period1=${p1}&period2=${p2}`;
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

// PM prediction grade/score/weight helpers.
// Grade is binary (A=correct, F=incorrect) — confidence doesn't change the letter.
// Weight (1/3/5) flows into the accuracy average: a less-confident correct call
// moves the needle less than a high-confidence one.
// Score rewards being right against the crowd: a correct call on a market that
// was already at 85% consensus is a much weaker demonstration of skill than a
// correct call on a market at 15%. Wrong calls stay flat — the crowd's
// confidence doesn't make a wrong call any less wrong.
function _pmScore(correct, lean, marketOddsAtTime) {
  if (!correct) return -65;
  if (marketOddsAtTime == null || !lean) return 65; // no odds captured — flat fallback
  const pSide = lean === 'Yes' ? marketOddsAtTime : (100 - marketOddsAtTime);
  // Markets surfaced on the platform are pre-filtered to roughly 15-85% Yes
  // (api/markets.js). Map 85 (pure consensus) -> 65, 15 (max contrarian
  // within that band) -> 100; values outside the band still clamp to [65,100].
  const edgeFraction = Math.max(0, Math.min(1, (85 - pSide) / 70));
  return +(65 + edgeFraction * 35).toFixed(1);
}
function _pmGrade(correct)    { return correct ? 'A' : 'F'; }
function _pmWeight(confStr)   {
  if (confStr === 'High')   return 5;
  if (confStr === 'Medium') return 3;
  return 1;
}

function _letterGrade(score) {
  if (score >= 60)  return 'A';
  if (score >= 25)  return 'B';
  if (score >= 0)   return 'C';
  if (score >= -25) return 'D';
  return 'F';
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleResolve(req, res, supabase) {
  const nowStr = new Date().toISOString();
  const nowMs  = Date.now();

  // ── 1. Fetch all unresolved predictions ──────────────────────────────────────
  const { data: all, error } = await supabase
    .from('predictions')
    .select('id, created_at, validation_date, winner_tickers, loser_tickers, baseline_prices, analysis, category, sources, lean, lean_confidence, market_slug, market_odds_at_time')
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
      tickerMoves[t] = { pct, direction: 'bullish', correct: pct >= 2, pts, basePrice: baseline[t], actualPrice: actual[t] };
    }
    for (const t of losers) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const pts = _tickerScore(pct, 'bearish');
      tickerMoves[t] = { pct, direction: 'bearish', correct: pct <= -2, pts, basePrice: baseline[t], actualPrice: actual[t] };
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
  // Check ALL unresolved PM predictions — Polymarket's closed/resolved flags are
  // the source of truth. Don't gate on validation_date: markets resolve as soon
  // as the outcome is known (e.g. MVP awarded before series ends), not on the
  // scheduled market close date.
  const pmReady = all.filter(p => {
    if (p.correct !== null) return false;
    const lean = p.lean || p.analysis?.lean;
    return lean === 'Yes' || lean === 'No';
  });

  const pmResolvedIds = new Set(); // track IDs graded in this step so step 9 can skip them

  for (const pred of pmReady) {
    const lean     = pred.lean || pred.analysis?.lean;
    const confStr  = pred.lean_confidence || pred.analysis?.lean_confidence || 'Low';
    const slug     = pred.market_slug;
    if (!slug) continue; // no slug — handled by step 9 fuzzy matching

    try {
      const r = await fetch(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) continue;
      const events = await r.json();
      const event  = Array.isArray(events) ? events[0] : events;
      if (!event?.closed) continue;
      // Use the highest-volume market as primary (multi-outcome events have many markets)
      const allMarkets = event.markets || [];
      const market = allMarkets.length === 1
        ? allMarkets[0]
        : [...allMarkets].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];
      if (!market) continue;

      let prices;
      try { prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices; }
      catch (_) { continue; }
      if (!Array.isArray(prices) || prices.length < 2) continue;

      // Require the oracle to have actually finalized the outcome. `event.closed` only
      // means trading halted — it flips true before resolution, and a closed-but-unresolved
      // market's price can still be a stale/interim read, not the true outcome. Trusting a
      // 97%+ price on a merely-closed market caused a false grade in production.
      if (market.umaResolutionStatus !== 'resolved') continue;

      const yesPrice = parseFloat(prices[0]);
      const outcome  = yesPrice >= 0.97 ? 'Yes' : yesPrice <= 0.03 ? 'No' : null;
      if (!outcome) continue;

      const leanCorrect   = lean === outcome;
      const accuracyScore = _pmScore(leanCorrect, lean, pred.market_odds_at_time);
      const pmGrade       = _pmGrade(leanCorrect);
      const confWeight    = _pmWeight(confStr);

      const { error: pmErr } = await supabase
        .from('predictions')
        .update({
          correct:         leanCorrect,
          validated_at:    nowStr,
          validation_date: nowStr,
          analysis:        {
            ...(pred.analysis || {}),
            grade: pmGrade, score: accuracyScore, accuracy_score: accuracyScore,
            confidence_weight: confWeight,
            resolved_outcome: outcome, lean_was: lean,
            officially_resolved: market.resolved ?? false,
          },
        })
        .eq('id', pred.id);
      if (!pmErr) { resolved++; pmResolvedIds.add(pred.id); }
    } catch (_) { /* skip on network error, retry next pass */ }
  }

  // ── 8. Clean up stock tickers from crypto-coin predictions ───────────────
  // Existing records stored before the single-coin rule had MSTR, IBIT, MARA,
  // RIOT, COIN, etc. mixed in alongside the coin. Strip them so only the coin
  // symbol remains in winner_tickers, loser_tickers, and baseline_prices.
  {
    const { data: cryptoPreds } = await supabase
      .from('predictions')
      .select('id, winner_tickers, loser_tickers, baseline_prices')
      .eq('category', 'crypto-coin')
      .limit(500);

    for (const p of cryptoPreds || []) {
      const cleanWinners = (p.winner_tickers || []).filter(t => _COIN_SYMS.has(t));
      const cleanLosers  = (p.loser_tickers  || []).filter(t => _COIN_SYMS.has(t));
      const winnersClean = cleanWinners.length === (p.winner_tickers || []).length;
      const losersClean  = cleanLosers.length  === (p.loser_tickers  || []).length;
      if (winnersClean && losersClean) continue;

      const cleanPrices = Object.fromEntries(
        Object.entries(p.baseline_prices || {}).filter(([k]) => _COIN_SYMS.has(k))
      );
      await supabase.from('predictions').update({
        winner_tickers:  cleanWinners,
        loser_tickers:   cleanLosers,
        baseline_prices: cleanPrices,
      }).eq('id', p.id);
    }
  }

  // ── 9. Delete crypto sub-event predictions saved before skipSave fix ────────
  // autoAnalyzeGroup topics follow the pattern "…: impact on CoinName (SYM) over the next…"
  // These were saved without skipSave:true before the fix; delete them so only
  // the overall prediction per coin appears in the history.
  {
    const subEventRx = /: impact on [A-Z][a-zA-Z\s]+ \([A-Z]+\) over the next/i;
    const { data: subEvents } = await supabase
      .from('predictions')
      .select('id, topic')
      .eq('category', 'crypto-coin')
      .limit(500);

    const toDelete = (subEvents || []).filter(p => subEventRx.test(p.topic || '')).map(p => p.id);
    if (toDelete.length) {
      for (let i = 0; i < toDelete.length; i += 50) {
        await supabase.from('predictions').delete().in('id', toDelete.slice(i, i + 50));
      }
    }
  }

  // ── 10. Retroactive PM grading via Polymarket text search ─────────────────
  // Fuzzy text matching for PM predictions that don't have a slug OR whose slug
  // lookup in step 7 failed (stale/wrong slug). Acts as a universal fallback.
  {
    const pmNoSlug = all.filter(p =>
      (p.lean || p.analysis?.lean) && p.correct === null && !pmResolvedIds.has(p.id)
    );

    if (pmNoSlug.length > 0) {
      // Fetch recently closed Polymarket events (recent 12 months).
      // The plain closed=true endpoint only returns old 2021-2023 data; end_date_min
      // is required to get recent markets.
      const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      let closedEvents = [];
      try {
        const r = await fetch(
          `https://gamma-api.polymarket.com/events?closed=true&limit=500&end_date_min=${oneYearAgo}`,
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
        if (!qWords.length) return { score: 0, matched: 0 };
        const tWords = new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/));
        const matched = qWords.filter(w => tWords.has(w)).length;
        return { score: matched / qWords.length, matched };
      }

      let pmTextMatched = 0;
      for (const pred of pmNoSlug) {
        const question = pred.topic || '';
        let bestEvent = null, bestScore = 0, bestMatched = 0, secondBestScore = 0;

        for (const event of Array.isArray(closedEvents) ? closedEvents : []) {
          const { score: s, matched } = _pmWordScore(question, event.title || '');
          if (s > bestScore) {
            secondBestScore = bestScore;
            bestScore = s; bestEvent = event; bestMatched = matched;
          } else if (s > secondBestScore) {
            secondBestScore = s;
          }
        }
        // Require strong, unambiguous word overlap before trusting a text match: at least
        // 70% of significant words (up from 55%, which let generic questions sharing only
        // "world"/"win"/"2026"-type words cross-match unrelated events), at least 3 matched
        // words (so a 70% match on a 3-word query isn't just 2 words), and a clear lead over
        // the next-best candidate (so two near-duplicate events, e.g. per-country markets in
        // the same event group, don't get resolved by a coin flip).
        if (bestScore < 0.7 || bestMatched < 3 || !bestEvent) continue;
        if (bestScore - secondBestScore < 0.15) continue;

        const allMkts = bestEvent.markets || [];
        const market = allMkts.length === 1
          ? allMkts[0]
          : [...allMkts].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];
        if (!market) continue;

        let prices;
        try {
          prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
        } catch (_) { continue; }
        if (!Array.isArray(prices) || prices.length < 2) continue;
        if (market.umaResolutionStatus !== 'resolved') continue;

        const yesPrice = parseFloat(prices[0]);
        const outcome = yesPrice >= 0.97 ? 'Yes' : yesPrice <= 0.03 ? 'No' : null;
        if (!outcome) continue;

        const lean        = pred.lean || pred.analysis?.lean;
        const confStr     = pred.lean_confidence || pred.analysis?.lean_confidence || 'Low';
        const leanCorrect = lean === outcome;
        const accScore    = _pmScore(leanCorrect, lean, pred.market_odds_at_time);
        const confWeight  = _pmWeight(confStr);

        const { error: pmErr2 } = await supabase
          .from('predictions')
          .update({
            correct:         leanCorrect,
            validated_at:    nowStr,
            validation_date: nowStr,
            market_slug:     bestEvent.slug || null,
            analysis: {
              ...(pred.analysis || {}),
              grade: _pmGrade(leanCorrect),
              score: accScore,
              accuracy_score: accScore,
              confidence_weight: confWeight,
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

  // ── One-time cleanup: delete junk 'x' predictions from diagnostic test ─────
  try {
    await supabase.from('predictions').delete().eq('topic', 'x');
  } catch (_) {}

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
  const clerkUser = await getClerkUser(req);
  const userId = clerkUser?.id ?? null;

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

  // Fetch resolved + pending predictions. Also always include prediction-market
  // predictions (have lean/signal) so they're never pushed off the list by
  // high-volume stock/crypto pending predictions.
  const PRED_SELECT = 'id, created_at, topic, winner_tickers, loser_tickers, correct, validation_date, analysis, category, lean, signal';
  const [{ data: resolvedAll, error: rErr }, { data: pendingRecent }, { data: pmPreds }] = await Promise.all([
    supabase
      .from('predictions')
      .select(PRED_SELECT)
      .not('correct', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('predictions')
      .select(PRED_SELECT)
      .is('correct', null)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('predictions')
      .select(PRED_SELECT)
      .not('lean', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);
  if (rErr) throw rErr;
  // Merge all three lists, dedupe by id, then sort newest-first
  const seenIds = new Set();
  const recent = [];
  for (const p of [...(pmPreds || []), ...(pendingRecent || []), ...(resolvedAll || [])]) {
    if (!seenIds.has(p.id)) { seenIds.add(p.id); recent.push(p); }
  }
  recent.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

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

  const _filterTickers = (tickers, category) =>
    category === 'crypto-coin' ? (tickers || []).filter(t => _COIN_SYMS.has(t)) : (tickers || []);
  const _filterMoves = (moves, category) =>
    category === 'crypto-coin' && moves
      ? Object.fromEntries(Object.entries(moves).filter(([k]) => _COIN_SYMS.has(k)))
      : moves || null;

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
          validationDate: p.validation_date,
          winnerTickers: _filterTickers(p.winner_tickers, p.category),
          loserTickers:  _filterTickers(p.loser_tickers,  p.category),
          correct: p.correct,
          confidence: p.analysis?.confidence || null,
          impactTimeframe: p.analysis?.impact_timeframe || null,
          grade: p.analysis?.grade || null,
          score: p.analysis?.accuracy_score ?? p.analysis?.score ?? null,
          tickerMoves: _filterMoves(p.analysis?.ticker_moves, p.category),
          category: p.category,
        })),
      };
    }
  }

  return res.status(200).json({
    summary: { total, correct, incorrect: total - correct, accuracy, pending: pending ?? 0, totalInDb: totalInDb ?? 0 },
    timeline, cumulativeTimeline, bySection, byCategory, topTickers,
    recent: (recent ?? []).map(p => ({
      id: p.id, topic: p.topic, createdAt: p.created_at,
      validationDate: p.validation_date,
      winnerTickers: _filterTickers(p.winner_tickers, p.category),
      loserTickers:  _filterTickers(p.loser_tickers,  p.category),
      correct: p.correct,
      confidence: p.analysis?.confidence || null,
      impactTimeframe: p.analysis?.impact_timeframe || null,
      grade: p.analysis?.grade || null,
      score: p.analysis?.accuracy_score ?? p.analysis?.score ?? null,
      tickerMoves: _filterMoves(p.analysis?.ticker_moves, p.category),
      category: p.category,
      lean: p.lean || p.analysis?.lean || null,
      signal: p.signal || p.analysis?.signal || null,
      analysis: { resolved_outcome: p.analysis?.resolved_outcome || null },
    }))
  });
}

// ── News-grade: daily news scan to grade pending PM predictions ───────────────
// Runs as a daily cron; grades predictions whose outcomes can be confirmed from
// recent news, independent of Polymarket resolution timing.

async function handleNewsGrade(req, res, supabase) {
  const nowStr = new Date().toISOString();
  const nowMs  = Date.now();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_KEY' });

  // Fetch pending PM predictions at least 1 day old (avoid grading same-day predictions)
  const oneDayAgo = new Date(nowMs - 86400000).toISOString();
  const { data: pending, error } = await supabase
    .from('predictions')
    .select('id, topic, created_at, lean, lean_confidence, analysis, market_slug, category, market_odds_at_time')
    .is('correct', null)
    .not('lean', 'is', null)
    .lt('created_at', oneDayAgo)
    .order('created_at', { ascending: true })
    .limit(25); // cap per run to control Claude API cost

  if (error) return res.status(500).json({ error: error.message });
  if (!pending?.length) return res.status(200).json({ graded: 0, checked: 0 });

  let graded = 0;
  const results = [];

  for (const pred of pending) {
    const topic = pred.topic || '';
    if (topic.length < 5) continue;

    // If we have a market slug, fetch the actual Polymarket market question so we know
    // exactly what YES and NO mean. Without this, "Cavaliers vs. Knicks" is ambiguous.
    let marketQuestion = topic;
    if (pred.market_slug) {
      try {
        const pr = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(pred.market_slug)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
        );
        if (pr.ok) {
          const pEvents = await pr.json();
          const pEvent  = Array.isArray(pEvents) ? pEvents[0] : pEvents;
          const mkt     = (pEvent?.markets || [])[0];
          if (mkt?.question) marketQuestion = mkt.question; // e.g. "Will the Cavaliers win Game 3?"
        }
      } catch (_) {}
    }

    // Build search query: strip leading "Will" and trailing "?" then take first 8 words
    const stripped  = marketQuestion.replace(/^Will\s+/i, '').replace(/\?$/, '').trim();
    const searchQ   = stripped.split(/\s+/).slice(0, 8).join(' ');

    try {
      const rssUrl  = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQ + ' result')}&hl=en-US&gl=US&ceid=US:en`;
      const rssRes  = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (!rssRes.ok) continue;
      const rssText = await rssRes.text();

      const articles = [];
      for (const m of [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12)) {
        const item       = m[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
        const srcMatch   = item.match(/<source[^>]*>(.*?)<\/source>/);
        const dateMatch  = item.match(/<pubDate>(.*?)<\/pubDate>/);
        if (!titleMatch) continue;
        const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
        if (title.length < 10) continue;
        let dateLabel = '';
        if (dateMatch?.[1]) {
          try { dateLabel = ` [${new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}]`; } catch (_) {}
        }
        articles.push(`"${title}" — ${(srcMatch?.[1] || 'Unknown').replace(/<[^>]*>/g, '').trim()}${dateLabel}`);
      }

      if (articles.length < 2) continue; // not enough signal

      const yesDefinition = marketQuestion !== topic
        ? `\nIMPORTANT: The exact Polymarket question is: "${marketQuestion}"\nYES means that specific question resolves true. NO means it resolves false.`
        : '';

      const prompt = `Today is ${nowStr.slice(0, 10)}. A prediction market was analyzed: "${topic}" (AI predicted: ${pred.lean})${yesDefinition}

Recent news (${articles.length} articles):
${articles.map(a => `- ${a}`).join('\n')}

Has the outcome been definitively determined? YES only if news explicitly confirms the event occurred. Map the real-world result to YES or NO using the exact market question above. Do NOT speculate.

Respond ONLY with valid JSON, no markdown:
{"outcome_known":true/false,"outcome":"Yes"/"No"/null,"confidence":"High"/"Medium"/"Low","confirmed_date":"YYYY-MM-DD"/null,"reasoning":"one sentence"}`;

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body:    JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
        signal:  AbortSignal.timeout(15000),
      });
      const apiData = await apiRes.json();
      if (apiData.error) continue;

      let assessment;
      try { assessment = JSON.parse(apiData.content[0].text.replace(/```json|```/g, '').trim()); }
      catch (_) { continue; }

      if (!assessment.outcome_known || (assessment.outcome !== 'Yes' && assessment.outcome !== 'No')) continue;
      if (assessment.confidence === 'Low') continue; // require at least Medium confidence

      const lean        = pred.lean;
      const leanCorrect = lean === assessment.outcome;
      const confStr     = pred.lean_confidence || pred.analysis?.lean_confidence || 'Low';
      const accScore    = _pmScore(leanCorrect, lean, pred.market_odds_at_time);
      const confWeight  = _pmWeight(confStr);

      let confirmedDate = nowStr;
      if (assessment.confirmed_date) {
        try { confirmedDate = new Date(assessment.confirmed_date).toISOString(); } catch (_) {}
      }

      const { error: updateErr } = await supabase
        .from('predictions')
        .update({
          correct:         leanCorrect,
          validated_at:    nowStr,
          validation_date: confirmedDate,
          analysis: {
            ...(pred.analysis || {}),
            grade:             _pmGrade(leanCorrect),
            score:             accScore,
            accuracy_score:    accScore,
            confidence_weight: confWeight,
            resolved_outcome:  assessment.outcome,
            lean_was:          lean,
            graded_by:         'news-scan',
            grading_reasoning: assessment.reasoning || null,
          },
        })
        .eq('id', pred.id);

      if (!updateErr) {
        graded++;
        results.push({ id: pred.id, topic: pred.topic, lean, outcome: assessment.outcome, correct });
      }
    } catch (_) { /* skip on error, retry tomorrow */ }
  }

  return res.status(200).json({ graded, checked: pending.length, results });
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
    if (req.method === 'POST')                       return res.status(405).json({ error: 'Method not allowed' });
    if (req.query.resolve      === 'true')           return await handleResolve(req, res, supabase);
    if (req.query['news-grade'] === 'true')          return await handleNewsGrade(req, res, supabase);
    if (req.query.graph        === 'true')           return await handleGraph(req, res, supabase);
    if (req.method === 'GET')                        return await handleStats(req, res, supabase);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[predictions]', err.message);
    return res.status(500).json({ error: 'Failed to load predictions' });
  }
}
