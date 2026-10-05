import { buildContextGraph } from '../lib/context-graph.js';
import { getClerkUser } from '../lib/auth.js';
import { COIN_SYMS } from '../lib/coin-symbols.js';
import { SECTION_CATS as _SECTION_CATS, SECTION_LABELS as _SECTION_LABELS, categoryToSection as _categoryToSection } from '../lib/prediction-sections.js';
import { computeAccuracyScore, SCORING_VERSION, HIT_THRESHOLD_PCT, hitRateBonus, classifyScore, tickerScore } from '../lib/scoring.js';
import { benchmarkFor, ALL_BENCHMARKS } from '../lib/benchmarks.js';
import { parseTimeframeDays as _parseTimeframeDays } from '../lib/timeframe.js';
import { wilsonInterval, wilsonIntervalFromP, wilsonLowerBound } from '../lib/stats.js';
import { parseConfidenceStars as _parseConfidenceStars } from '../lib/confidence.js';
import { pickPmMarket as _pickPmMarket, pmOutcome as _pmOutcome, pmWordScore as _pmWordScore } from '../lib/pm-resolution.js';
import { isValidTickerFormat } from '../lib/ticker-format.js';
import { getSupabase, setCors, secretMatches } from '../lib/http.js';
import { fetchYahooChartSeries } from '../lib/yahoo-chart.js';

// Grading (resolve / news-grade) writes to the DB and spends LLM/external-API
// budget, so it must not be publicly triggerable. Vercel automatically sends
// `Authorization: Bearer $CRON_SECRET` on its own cron-triggered requests
// when CRON_SECRET is set — no vercel.json change needed for that path. The
// `x-cron-secret` header exists only for manual/admin triggering (e.g. via
// curl). There's deliberately no ?secret= query param: URLs end up in logs.
function _isAuthorizedForGrading(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const authHeader  = req.headers['authorization'];
  const manualToken = req.headers['x-cron-secret'];
  return secretMatches(authHeader, `Bearer ${cronSecret}`) || secretMatches(manualToken, cronSecret);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _sectionStats(preds, pendingBySection = {}) {
  const map = {};
  for (const p of preds) {
    const sec = _categoryToSection(p.category || 'any');
    if (!map[sec]) map[sec] = { correct: 0, total: 0 };
    map[sec].total++;
    // Uses the same `correct` boolean as every other accuracy number on the
    // page — this used to be an independent "lenient" score > -15 threshold
    // that could show a different percentage than everywhere else for the
    // same underlying predictions.
    if (p.correct) map[sec].correct++;
  }
  return Object.entries(_SECTION_LABELS).map(([sec, label]) => {
    const d = map[sec] || { correct: 0, total: 0 };
    const ci = d.total > 0 ? wilsonInterval(d.correct, d.total) : null;
    return {
      section:  sec,
      label,
      total:    d.total,
      pending:  pendingBySection[sec] || 0,
      accuracy: d.total > 0 ? Math.round(d.correct / d.total * 100) : null,
      // 95% Wilson score interval — n (`total`) is small for some sections
      // (Crypto, Prediction Markets), where a bare percentage overstates
      // precision. null until there's at least one resolved prediction.
      accuracyCI: ci ? { lower: Math.round(ci.lower * 100), upper: Math.round(ci.upper * 100) } : null,
    };
  });
}

const _COIN_SYMS = COIN_SYMS;

// Fetch the FULL daily price history for a ticker over a date range in ONE request.
// Returns a map of { "YYYY-MM-DD": closePrice } covering all trading days in the range.
async function _fetchTickerHistory(ticker, startMs, endMs) {
  const p1 = Math.floor(startMs / 1000) - 7 * 86400; // 1 week buffer before
  const p2 = Math.floor(endMs   / 1000) + 7 * 86400; // 1 week buffer after
  const series = await fetchYahooChartSeries(ticker, p1, p2, { timeoutMs: 12000 });
  if (!series) return {};
  const { timestamps, closes } = series;
  const map = {};
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    map[new Date(timestamps[i] * 1000).toISOString().slice(0, 10)] = +closes[i].toFixed(4);
  }
  return map;
}

// Look up the price closest to targetDate in a pre-fetched history map.
// Returns { price: null } if no price within 5 trading days (7 calendar
// days). diffDays is returned even when the match is rejected, so a caller
// can log how far off the nearest available data actually was — previously
// a stale match hiding inside the 7-day tolerance left no trace of the gap
// (see the 2026-10 grading audit, which found a prediction graded off a
// price 3 days from its real validation date with nothing recording it).
function _priceOnDate(historyMap, targetDate) {
  const keys = Object.keys(historyMap);
  if (!keys.length) return { price: null, diffDays: null };
  const targetMs = targetDate.getTime();
  let best = null, bestDiff = Infinity;
  for (const k of keys) {
    const diff = Math.abs(new Date(k).getTime() - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = k; }
  }
  const diffDays = +(bestDiff / 86400000).toFixed(2);
  return { price: diffDays <= 7 ? historyMap[best] : null, diffDays };
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
// PM predictions moved from a 3-bucket High/Medium/Low lean_confidence (which
// could only ever land on weight 5/3/1, making 2 and 4 mathematically
// unreachable) to the same numeric "N — reason" scale stock/crypto already
// uses (see the CONFIDENCE rubric in api/market-analyze.js). Try the numeric
// parse first; fall back to the legacy text mapping so historical rows still
// get a sensible weight instead of collapsing to a default.
function _pmWeight(confStr)   {
  const m = String(confStr || '').match(/^\s*([1-5])/);
  if (m) return parseInt(m[1]);
  if (confStr === 'High')   return 5;
  if (confStr === 'Medium') return 3;
  return 1;
}

// Prediction-market edge: our hit rate vs. always picking the crowd favorite
// (the side priced above 50% when we made the call), plus the call rate since
// close calls started becoming briefings (api/market-analyze.js PM_MODEL_VERSION).
// Hit rates are unweighted on purpose — the crowd has no confidence weights, so
// a like-for-like comparison has to count every call once.
async function _pmEdgeStats(validated, supabase) {
  const graded = (validated || []).filter(p => p.lean === 'Yes' || p.lean === 'No');
  if (!graded.length) return null;
  const ours = graded.filter(p => p.correct).length;

  let crowdN = 0, crowdCorrect = 0;
  // Brier score (mean squared error of the YES probability vs. the 0/1
  // outcome; 0 = perfect, 0.25 = always saying 50%). Scored on the same rows
  // for both sides, so it only counts calls that stored a probability
  // (pm-prob-v1 onward). Same formula as scripts/diagnose-pm-edge.js.
  let brierN = 0, modelSq = 0, crowdSq = 0;
  for (const p of graded) {
    const odds = p.market_odds_at_time;
    const outcome = p.analysis?.resolved_outcome || (p.correct ? p.lean : (p.lean === 'Yes' ? 'No' : 'Yes'));
    const hit = outcome === 'Yes' ? 1 : 0;
    const prob = p.analysis?.yes_probability;
    if (odds != null && typeof prob === 'number') {
      brierN++;
      modelSq += (prob / 100 - hit) ** 2;
      crowdSq += (odds / 100 - hit) ** 2;
    }
    if (odds == null || odds === 50) continue;
    crowdN++;
    if ((odds > 50 ? 'Yes' : 'No') === outcome) crowdCorrect++;
  }

  let calls = null, briefings = null, callRate = null;
  try {
    const [{ count: c }, { count: b, error: bErr }] = await Promise.all([
      supabase.from('predictions').select('id', { count: 'exact', head: true })
        .in('lean', ['Yes', 'No']).not('analysis->>pm_model_version', 'is', null),
      supabase.from('pm_briefings').select('id', { count: 'exact', head: true }),
    ]);
    if (!bErr && (c ?? 0) + (b ?? 0) > 0) {
      calls = c ?? 0; briefings = b ?? 0;
      callRate = Math.round(calls / (calls + briefings) * 100);
    }
  } catch (_) { /* pm_briefings not migrated yet — call rate stays null */ }

  return {
    graded: graded.length,
    accuracy: Math.round(ours / graded.length * 100),
    crowdN,
    crowdAccuracy: crowdN ? Math.round(crowdCorrect / crowdN * 100) : null,
    calls, briefings, callRate,
    brierN,
    modelBrier: brierN ? +(modelSq / brierN).toFixed(4) : null,
    crowdBrier: brierN ? +(crowdSq / brierN).toFixed(4) : null,
  };
}

// ── Route handlers ────────────────────────────────────────────────────────────

// Stock/crypto rows (lean IS NULL) are graded from price history once their
// validation date passes; prediction-market rows (lean Yes/No) are graded from
// Polymarket's own resolution. The two run independently — they used to share
// one oldest-1000 query with an early return when no price rows were due, so
// PM grading silently never ran on those passes and newer PM rows sat behind
// the backlog of long-dated ones.
async function handleResolve(req, res, supabase) {
  const nowStr = new Date().toISOString();
  const nowMs  = Date.now();

  const [prices, markets] = await Promise.all([
    _resolvePriceBased(supabase, nowStr, nowMs).catch(err => ({ resolved: 0, error: err.message })),
    _resolvePredictionMarkets(supabase, nowStr, nowMs).catch(err => ({ resolved: 0, error: err.message })),
  ]);
  await _cleanCryptoTickers(supabase).catch(() => {});

  return res.status(200).json({ resolved: prices.resolved + markets.resolved, prices, markets });
}

async function _resolvePriceBased(supabase, nowStr, nowMs) {
  // ── 1. Fetch unresolved stock/crypto predictions that could be due ─────────
  // Rows with no stored validation_date fall back to created_at + timeframe
  // below, so they're fetched too.
  const { data: all, error } = await supabase
    .from('predictions')
    .select('id, topic, created_at, validation_date, winner_tickers, loser_tickers, baseline_prices, analysis, category, sources, status, retry_count')
    .is('correct', null)
    .is('lean', null)
    .neq('status', 'failed')
    .or(`validation_date.is.null,validation_date.lte.${nowStr}`)
    .order('created_at', { ascending: true })
    .limit(1000);

  if (error) throw error;
  if (!all?.length) return { resolved: 0, due: 0 };

  // ── 2. Derive effective validation date for each; keep only expired ones ───
  // (status === 'failed' rows are permanently excluded here — they've already
  // exhausted MAX_RESOLVE_RETRIES and are surfaced in handleStats instead.)
  const ready = [];
  for (const p of all) {
    if (p.status === 'failed') continue;
    if (!p.winner_tickers?.length && !p.loser_tickers?.length) continue;
    let vDate = p.validation_date ? new Date(p.validation_date) : null;
    if (!vDate && p.created_at) {
      const days = _parseTimeframeDays(p.analysis?.impact_timeframe);
      vDate = new Date(new Date(p.created_at).getTime() + days * 86400000);
    }
    if (!vDate || vDate.getTime() > nowMs) continue; // not expired yet
    ready.push({ ...p, _vDate: vDate });
  }

  if (!ready.length) return { resolved: 0, due: 0 };

  // ── 2.5. Atomically claim the ready rows before spending API budget on them ──
  // Guards against a slow resolve run overlapping the next scheduled one (or a
  // manual trigger overlapping the cron): each UPDATE's WHERE clause only
  // matches rows still in 'pending' (or stuck 'resolving' past the stale
  // cutoff), so a row already claimed by a concurrent run won't be re-claimed
  // here — Postgres serializes the two UPDATEs and the loser's WHERE simply
  // stops matching. Only rows actually returned by the UPDATE are graded.
  const STALE_MS = 15 * 60 * 1000;
  const staleCutoff = new Date(nowMs - STALE_MS).toISOString();
  const readyIds = ready.map(p => p.id);
  const claimed = new Set();
  for (let i = 0; i < readyIds.length; i += 200) {
    const chunk = readyIds.slice(i, i + 200);
    const { data: claimedRows, error: claimErr } = await supabase
      .from('predictions')
      .update({ status: 'resolving', resolving_since: nowStr })
      .in('id', chunk)
      .or(`status.eq.pending,and(status.eq.resolving,resolving_since.lt.${staleCutoff})`)
      .select('id');
    if (claimErr) continue; // best-effort; unclaimed rows just get skipped below
    for (const r of claimedRows || []) claimed.add(r.id);
  }
  const claimedReady = ready.filter(p => claimed.has(p.id));
  if (!claimedReady.length) {
    return { resolved: 0, due: ready.length, claimed: 0 };
  }

  // ── 3. Collect unique tickers and the overall date range ──────────────────
  const uniqueTickers = new Set();
  let minMs = nowMs, maxMs = 0;
  for (const p of claimedReady) {
    for (const t of [...(p.winner_tickers || []), ...(p.loser_tickers || [])]) {
      if (isValidTickerFormat(t)) uniqueTickers.add(t);
    }
    const createdMs = new Date(p.created_at).getTime();
    if (createdMs < minMs) minMs = createdMs;
    if (p._vDate.getTime() > maxMs) maxMs = p._vDate.getTime();
  }
  // Alpha-adjusted scoring (lib/scoring.js) needs each benchmark's own price
  // history over the same window — see lib/benchmarks.js.
  for (const b of ALL_BENCHMARKS) uniqueTickers.add(b);

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

  // A failed benchmark fetch (SPY/BTC) silently strips alpha adjustment from
  // EVERY prediction in this batch, not just one — worth one retry after the
  // rest of the batch has had a chance to clear any transient rate limit,
  // rather than accepting the whole batch grading without benchmark data.
  for (const b of ALL_BENCHMARKS) {
    if (Object.keys(histories[b] || {}).length) continue;
    console.error('[predictions/resolve] benchmark history came back empty, retrying once', { ticker: b });
    await new Promise(r => setTimeout(r, 1000));
    histories[b] = await _fetchTickerHistory(b, minMs, maxMs);
    if (!Object.keys(histories[b] || {}).length) {
      console.error('[predictions/resolve] benchmark history still empty after retry — this batch will grade without alpha adjustment', { ticker: b });
    }
  }

  // ── 5. Score every prediction from the cached history ─────────────────────
  const updates = [];
  let skipped = 0;

  for (const pred of claimedReady) {
    const winners    = (pred.winner_tickers || []).filter(t => histories[t]);
    const losers     = (pred.loser_tickers  || []).filter(t => histories[t]);
    if (!winners.length && !losers.length) { skipped++; continue; }

    const createdDate = new Date(pred.created_at);
    const valDate     = pred._vDate;

    // Build baseline: stored price preferred; fall back to price at created_at from history.
    // baseDateDiffDays stays unset for a stored (live-quote) baseline — the
    // diff concept only applies to a price pulled from daily-close history.
    const baseline = { ...(pred.baseline_prices || {}) };
    const baseDateDiffDays = {};
    for (const t of [...winners, ...losers]) {
      if (!baseline[t] && histories[t]) {
        const { price, diffDays } = _priceOnDate(histories[t], createdDate);
        if (price != null) { baseline[t] = price; baseDateDiffDays[t] = diffDays; }
      }
    }

    // Actual price: price at the validation date from history. Always comes
    // from here (no live-quote alternative), so diffDays is always known.
    const actual = {};
    const actualDateDiffDays = {};
    for (const t of [...winners, ...losers]) {
      if (histories[t]) {
        const { price, diffDays } = _priceOnDate(histories[t], valDate);
        if (price != null) { actual[t] = price; actualDateDiffDays[t] = diffDays; }
      }
    }

    // Benchmark return over the SAME window, for alpha adjustment. Computed
    // fresh from history (not the ticker's own possibly-stored baseline) so
    // it's on equal footing regardless of where the ticker's baseline came
    // from. Missing/unavailable benchmark data just means no adjustment —
    // computeAccuracyScore falls back to the raw return automatically, but
    // the move also gets tagged `benchmarkUnavailable` so that fallback is
    // distinguishable later from a genuine alpha of 0 (see the 2026-10
    // grading audit, which found ~27% of alpha-scored predictions had
    // silently lost benchmark adjustment with no way to tell after the fact).
    const _benchmarkPctCache = {};
    function benchmarkPctFor(benchTicker) {
      if (!benchTicker || !histories[benchTicker]) return null;
      if (benchTicker in _benchmarkPctCache) return _benchmarkPctCache[benchTicker];
      const { price: bBase } = _priceOnDate(histories[benchTicker], createdDate);
      const { price: bAct }  = _priceOnDate(histories[benchTicker], valDate);
      const result = (bBase != null && bAct != null) ? (bAct - bBase) / bBase * 100 : null;
      _benchmarkPctCache[benchTicker] = result;
      return result;
    }

    const rawMoves = {};
    for (const t of winners) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const expectedBenchmark = benchmarkFor(t, _COIN_SYMS.has(t));
      const benchPct = benchmarkPctFor(expectedBenchmark);
      const alphaPct = benchPct != null ? +(pct - benchPct).toFixed(2) : undefined;
      rawMoves[t] = {
        pct, alphaPct, direction: 'bullish', basePrice: baseline[t], actualPrice: actual[t],
        baseDateDiffDays: baseDateDiffDays[t], actualDateDiffDays: actualDateDiffDays[t],
        benchmarkUnavailable: expectedBenchmark != null && benchPct == null,
      };
    }
    for (const t of losers) {
      if (!baseline[t] || !actual[t]) continue;
      const pct = +((actual[t] - baseline[t]) / baseline[t] * 100).toFixed(2);
      const expectedBenchmark = benchmarkFor(t, _COIN_SYMS.has(t));
      const benchPct = benchmarkPctFor(expectedBenchmark);
      const alphaPct = benchPct != null ? +(pct - benchPct).toFixed(2) : undefined;
      rawMoves[t] = {
        pct, alphaPct, direction: 'bearish', basePrice: baseline[t], actualPrice: actual[t],
        baseDateDiffDays: baseDateDiffDays[t], actualDateDiffDays: actualDateDiffDays[t],
        benchmarkUnavailable: expectedBenchmark != null && benchPct == null,
      };
    }

    const result = computeAccuracyScore(rawMoves);
    if (!result) { skipped++; continue; }

    const {
      tickerMoves, accuracyScore, correct, outcome, grade,
      rawAccuracyScore, rawCorrect, rawGrade,
    } = result;
    const confidence_weight  = _parseConfidenceStars(pred.analysis?.confidence);

    updates.push({
      id: pred.id, correct,
      validated_at:    nowStr,
      validation_date: valDate.toISOString(),
      baseline_prices: baseline,
      actual_prices:   actual,
      analysis: {
        ...(pred.analysis || {}),
        grade, score: accuracyScore, accuracy_score: accuracyScore, outcome,
        // Pre-alpha-adjustment score, kept for reference/comparison — NOT
        // used for `correct`/grade, which are alpha-based (see lib/scoring.js).
        raw_accuracy_score: rawAccuracyScore, raw_correct: rawCorrect, raw_grade: rawGrade,
        scoring_version: SCORING_VERSION, confidence_weight, ticker_moves: tickerMoves,
      },
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
            status:          'resolved',
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

  // Release the claim on claimed-but-skipped rows (no gradeable price data
  // this run — e.g. Yahoo Finance fetch failures, which are swallowed to {}
  // by _fetchTickerHistory) so they go back to 'pending' and get retried next
  // pass instead of sitting stuck in 'resolving'. Past MAX_RESOLVE_RETRIES
  // consecutive failures, mark 'failed' instead so a permanently-unfetchable
  // ticker (delisted, bad symbol, etc.) doesn't retry forever unnoticed —
  // handleStats surfaces the failed count.
  const MAX_RESOLVE_RETRIES = 5;
  const gradedIds = new Set(updates.map(u => u.id));
  const toRelease = claimedReady.filter(p => !gradedIds.has(p.id));
  for (const p of toRelease) {
    const nextRetryCount = (p.retry_count || 0) + 1;
    const willFail = nextRetryCount >= MAX_RESOLVE_RETRIES;
    if (willFail) {
      console.error('[predictions/resolve] giving up on prediction after repeated price-data failures', {
        id: p.id, topic: p.topic, winnerTickers: p.winner_tickers, loserTickers: p.loser_tickers,
        retryCount: nextRetryCount, timestamp: nowStr,
      });
    }
    await supabase
      .from('predictions')
      .update({
        status: willFail ? 'failed' : 'pending',
        resolving_since: null,
        retry_count: nextRetryCount,
      })
      .eq('id', p.id);
  }

  return { resolved, skipped, due: ready.length, claimed: claimedReady.length };
}

// Clean up stock tickers from crypto-coin predictions.
// Existing records stored before the single-coin rule had MSTR, IBIT, MARA,
// RIOT, COIN, etc. mixed in alongside the coin. Strip them so only the coin
// symbol remains in winner_tickers, loser_tickers, and baseline_prices.
async function _cleanCryptoTickers(supabase) {
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


// ── Prediction market resolution (Polymarket) ─────────────────────────────────

function _pmGradeUpdate(pred, outcome, nowStr, extraAnalysis = {}) {
  const leanCorrect = pred.lean === outcome;
  const accuracyScore = _pmScore(leanCorrect, pred.lean, pred.market_odds_at_time);
  return {
    correct:         leanCorrect,
    validated_at:    nowStr,
    validation_date: nowStr,
    status:          'resolved',
    analysis: {
      ...(pred.analysis || {}),
      grade: _pmGrade(leanCorrect), score: accuracyScore, accuracy_score: accuracyScore,
      confidence_weight: _pmWeight(pred.lean_confidence || pred.analysis?.lean_confidence || 'Low'),
      resolved_outcome: outcome, lean_was: pred.lean,
      ...extraAnalysis,
    },
  };
}

async function _fetchPmEvent(slug) {
  try {
    const r = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const events = await r.json();
    return (Array.isArray(events) ? events[0] : events) || null;
  } catch (_) { return null; }
}

// Stays inside the route's 60s maxDuration alongside the price grader.
const PM_RESOLVE_BUDGET_MS = 40000;
const PM_FETCH_CONCURRENCY = 8;

async function _resolvePredictionMarkets(supabase, nowStr, nowMs) {
  const deadline = nowMs + PM_RESOLVE_BUDGET_MS;

  // ── 1. Every unresolved PM prediction (paged — the backlog of long-dated
  //    markets can run past a single 1000-row page). `analysis` is fetched
  //    later, only for the rows actually being graded.
  const pending = [];
  for (let from = 0; from < 10000; from += 1000) {
    const { data, error } = await supabase
      .from('predictions')
      .select('id, topic, created_at, validation_date, lean, lean_confidence, market_slug, market_odds_at_time, sources')
      .is('correct', null)
      .in('lean', ['Yes', 'No'])
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    pending.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  if (!pending.length) return { resolved: 0, pending: 0 };

  // ── 2. Check the markets most likely to have resolved first: past their end
  //    date, then no end date, then soonest-ending. Markets can resolve before
  //    their scheduled end (MVP awarded before the series ends), so future ones
  //    are still checked — just after, and only while budget remains.
  const dueKey = p => {
    const v = p.validation_date ? new Date(p.validation_date).getTime() : null;
    if (v == null) return [1, 0];
    return v <= nowMs ? [0, v] : [2, v];
  };
  pending.sort((a, b) => { const x = dueKey(a), y = dueKey(b); return x[0] - y[0] || x[1] - y[1]; });

  // The same market is often predicted on several days — one fetch per slug.
  const bySlug = new Map();
  for (const p of pending) {
    if (!p.market_slug) continue;
    if (!bySlug.has(p.market_slug)) bySlug.set(p.market_slug, []);
    bySlug.get(p.market_slug).push(p);
  }

  const toGrade = []; // { pred, outcome, extra }
  const graded = new Set();
  const slugs = [...bySlug.keys()];
  let slugIdx = 0, slugsChecked = 0;
  async function worker() {
    while (slugIdx < slugs.length && Date.now() < deadline) {
      const slug = slugs[slugIdx++];
      const event = await _fetchPmEvent(slug);
      slugsChecked++;
      if (!event) continue;
      for (const pred of bySlug.get(slug)) {
        const outcome = _pmOutcome(_pickPmMarket(event, pred.topic));
        if (outcome) { toGrade.push({ pred, outcome, extra: {} }); graded.add(pred.id); }
      }
    }
  }
  await Promise.all(Array.from({ length: PM_FETCH_CONCURRENCY }, worker));

  // ── 3. Fallback for rows with no slug (or a stale one): fuzzy-match the
  //    question against recently closed events.
  const unmatched = pending.filter(p => !graded.has(p.id) && (!p.market_slug || dueKey(p)[0] === 0));
  let textMatched = 0;
  if (unmatched.length && Date.now() < deadline) {
    // The plain closed=true endpoint only returns old 2021-2023 data;
    // end_date_min is required to get recent markets.
    const oneYearAgo = new Date(nowMs - 365 * 86400000).toISOString().slice(0, 10);
    let closedEvents = [];
    try {
      const r = await fetch(
        `https://gamma-api.polymarket.com/events?closed=true&limit=500&end_date_min=${oneYearAgo}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) }
      );
      if (r.ok) closedEvents = await r.json();
    } catch (_) {}
    if (!Array.isArray(closedEvents)) closedEvents = [];

    for (const pred of unmatched) {
      const question = pred.topic || '';
      let bestEvent = null, bestScore = 0, bestMatched = 0, secondBestScore = 0;
      for (const event of closedEvents) {
        const { score: s, matched } = _pmWordScore(question, event.title || '');
        if (s > bestScore) {
          secondBestScore = bestScore;
          bestScore = s; bestEvent = event; bestMatched = matched;
        } else if (s > secondBestScore) {
          secondBestScore = s;
        }
      }
      // Require strong, unambiguous word overlap before trusting a text match: at least
      // 70% of significant words (55% let generic questions sharing only
      // "world"/"win"/"2026"-type words cross-match unrelated events), at least 3 matched
      // words, and a clear lead over the next-best candidate (so two near-duplicate
      // events, e.g. per-country markets in the same event group, don't get resolved by
      // a coin flip).
      if (bestScore < 0.7 || bestMatched < 3 || !bestEvent) continue;
      if (bestScore - secondBestScore < 0.15) continue;

      const outcome = _pmOutcome(_pickPmMarket(bestEvent, question));
      if (!outcome) continue;
      toGrade.push({ pred, outcome, extra: { text_match_pct: Math.round(bestScore * 100) }, slug: bestEvent.slug || null });
      graded.add(pred.id);
      textMatched++;
    }
  }

  // ── 4. Write grades (merging into each row's existing analysis JSON).
  let resolved = 0;
  for (let i = 0; i < toGrade.length; i += 100) {
    const chunk = toGrade.slice(i, i + 100);
    const { data: full } = await supabase.from('predictions').select('id, analysis').in('id', chunk.map(g => g.pred.id));
    const analysisById = new Map((full || []).map(r => [r.id, r.analysis]));
    await Promise.allSettled(chunk.map(async ({ pred, outcome, extra, slug }) => {
      const update = _pmGradeUpdate({ ...pred, analysis: analysisById.get(pred.id) }, outcome, nowStr, extra);
      if (slug !== undefined) update.market_slug = slug;
      // `correct IS NULL` guard: never overwrite a grade another pass already wrote.
      const { data, error } = await supabase.from('predictions').update(update).eq('id', pred.id).is('correct', null).select('id');
      if (!error && data?.length) {
        resolved++;
        // Same feedback loop the stock/crypto resolver already runs (see
        // _resolvePriceBased above) — without this, PM predictions (politics/
        // sports/entertainment/finance markets) would read source_reputation
        // via getSourceGrade() when generated but never write back their own
        // outcome, so that half of the platform's predictions never taught the
        // source-quality model anything.
        if (pred.sources?.length) {
          await Promise.allSettled(pred.sources.map(src =>
            supabase.rpc('upsert_source_reputation', { p_source: src, p_correct: update.correct ? 1 : 0 })
          ));
        }
      }
    }));
  }

  return {
    resolved, textMatched, pending: pending.length,
    slugs: slugs.length, slugsChecked,
    budgetExhausted: slugsChecked < slugs.length,
  };
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

// Pure direction accuracy for one prediction: did the pick's price move the
// way it called, with NO benchmark/alpha adjustment anywhere in the
// calculation (unlike `analysis.raw_correct`, which still inherits an
// alpha-based hit-rate bonus from computeAccuracyScore — see lib/scoring.js
// — and so barely differs from the alpha-adjusted `correct`). Recomputed
// from the raw pct/direction already stored per ticker in
// `analysis.ticker_moves` rather than trusting any stored "raw" field, since
// those fields were never meant to be alpha-free. PM predictions have no
// alpha concept to begin with, so their `correct` is already pure.
function _pureDirectionCorrect(p) {
  if (p.lean) return p.correct;
  const moves = Object.values(p.analysis?.ticker_moves || {})
    .filter(m => typeof m.pct === 'number' && (m.direction === 'bullish' || m.direction === 'bearish'));
  if (!moves.length) return null;
  const hitCount = moves.filter(m =>
    m.direction === 'bullish' ? m.pct >= HIT_THRESHOLD_PCT : m.pct <= -HIT_THRESHOLD_PCT
  ).length;
  const bonus  = hitRateBonus(hitCount, moves.length);
  const avgRaw = moves.reduce((sum, m) => sum + tickerScore(m.pct, m.direction), 0) / moves.length;
  return classifyScore(avgRaw + bonus).correct;
}

async function handleStats(req, res, supabase) {
  const { data: validated, error: vErr } = await supabase
    .from('predictions')
    .select('id, created_at, topic, winner_tickers, loser_tickers, correct, analysis, validation_date, validated_at, actual_prices, baseline_prices, category, lean, market_odds_at_time')
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
  const { count: pendingBaselineCount } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .is('correct', null)
    .eq('analysis->>baseline_generated', 'true');
  const pending = pendingCount;

  const { count: totalInDb } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true });

  // Predictions that exhausted MAX_RESOLVE_RETRIES in handleResolve (price
  // data unavailable, e.g. a delisted/bad ticker symbol) — surfaced so they
  // aren't just silently invisible pending-forever rows.
  const { count: failedCount } = await supabase
    .from('predictions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed');

  // `generate-baseline`'s cron (api/generate-baseline.js) fills out the
  // dashboard with cold, no-news/no-source directional guesses on every
  // stock/coin so every section has volume — useful for coverage, but by
  // 2026-09 it was already outproducing a full prior QUARTER of organic
  // (real, news-driven) predictions in a single month. Blending it into the
  // headline silently dilutes the "did InfoBlade's actual analysis call it
  // right" number with a population that was never trying to be a genuine
  // editorial call — see the 2026-10 grading audit. The headline below is
  // organic-only; baseline-generated gets its own clearly separate summary
  // further down so it's visible, not hidden, just not blended in.
  const organicValidated  = (validated ?? []).filter(p => !p.analysis?.baseline_generated);
  const baselineValidated = (validated ?? []).filter(p =>  p.analysis?.baseline_generated);
  const total = organicValidated.length;

  // Confidence-weighted accuracy: high-confidence correct predictions count more.
  // This is the alpha-adjusted number: a stock/crypto call only counts as
  // correct if it beat its benchmark, not just moved the predicted direction
  // (see lib/scoring.js). PM predictions have no alpha concept, so `correct`
  // there is just whether the market resolved the way the call leaned.
  //
  // Computes the same {accuracy, rawAccuracy, correct, CI} shape for any
  // population — called once for the organic (headline) set and once for
  // the baseline-generated set, so the two stay structurally identical and
  // can't silently drift into different definitions of "accuracy."
  function _accuracySummary(preds) {
    let weightedCorrect = 0, totalWeight = 0, rawWeightedCorrect = 0, rawTotalWeight = 0;
    for (const p of preds) {
      const w = p.analysis?.confidence_weight ?? _parseConfidenceStars(p.analysis?.confidence);
      totalWeight += w;
      if (p.correct) weightedCorrect += w;

      const rawCorrect = _pureDirectionCorrect(p);
      if (typeof rawCorrect === 'boolean') {
        rawTotalWeight += w;
        if (rawCorrect) rawWeightedCorrect += w;
      }
    }
    const n = preds.length;
    const correct = preds.filter(p => p.correct === true).length;
    const accuracy = totalWeight > 0 ? Math.round(weightedCorrect / totalWeight * 100) : null;
    const rawAccuracy = rawTotalWeight > 0 ? Math.round(rawWeightedCorrect / rawTotalWeight * 100) : null;
    // 95% Wilson interval around the headline number, using the resolved
    // prediction count as n — a ballpark uncertainty band ("83% ± 10%
    // (n=48)" reads very differently from a bare "83%").
    let accuracyCI = null;
    if (n > 0) {
      const ci = wilsonIntervalFromP((accuracy ?? 0) / 100, n);
      accuracyCI = { lower: Math.round(ci.lower * 100), upper: Math.round(ci.upper * 100) };
    }
    let rawAccuracyCI = null;
    if (rawTotalWeight > 0) {
      const ci = wilsonIntervalFromP((rawAccuracy ?? 0) / 100, n);
      rawAccuracyCI = { lower: Math.round(ci.lower * 100), upper: Math.round(ci.upper * 100) };
    }
    return { total: n, correct, incorrect: n - correct, accuracy, accuracyCI, rawAccuracy, rawAccuracyCI };
  }

  const organicSummary  = _accuracySummary(organicValidated);
  const baselineSummary = _accuracySummary(baselineValidated);
  const { correct, accuracy, accuracyCI, rawAccuracy, rawAccuracyCI } = organicSummary;

  // How many of the organic (headline) predictions predate benchmark-relative
  // scoring entirely (no scoring_version — see SCORING_VERSION in
  // lib/scoring.js) and so never had to beat SPY/BTC to score "correct".
  // `accuracy`/`accuracyCI` ("beat the market") and the cumulative score
  // chart below still blend these in with real alpha-scored predictions —
  // flagged here rather than silently excluded, since whether/how to
  // separate them is a methodology call, not a bug fix (2026-10 audit).
  const legacyCount = organicValidated.filter(p => !p.lean && !p.analysis?.scoring_version).length;

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

  // Cumulative weighted score timeline (running total, oldest-first).
  // Organic-only, same as the headline accuracy above — baseline-generated
  // cold guesses would otherwise dominate the curve by sheer volume without
  // ever having tried to be a real editorial call (see organicValidated).
  const validatedAsc = [...organicValidated].sort((a, b) => a.created_at.localeCompare(b.created_at));
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

  // Organic-only, same reasoning as the cumulative timeline above — a
  // ticker's leaderboard win rate shouldn't be built from cold auto-guesses.
  const tickerStats = {};
  for (const p of organicValidated) {
    const section = _categoryToSection(p.category || 'any');
    for (const t of [...new Set([...(p.winner_tickers || []), ...(p.loser_tickers || [])])]) {
      if (!tickerStats[t]) tickerStats[t] = { wins: 0, total: 0, section };
      tickerStats[t].total++;
      if (p.correct) tickerStats[t].wins++;
    }
  }
  // Minimum n=5 before a ticker is eligible for the leaderboard at all (a
  // 1/1 or 2/2 "100% win rate" is statistically meaningless but visually
  // reads as a strong claim). Sorted by Wilson-lower-bound, not raw win
  // rate, so a small sample at a high raw rate (5/5) doesn't automatically
  // outrank a much larger sample at a slightly lower rate (40/50) that's
  // actually stronger evidence.
  const TOP_TICKERS_MIN_N = 5;
  const topTickers = Object.entries(tickerStats)
    .filter(([, s]) => s.total >= TOP_TICKERS_MIN_N)
    .map(([ticker, s]) => ({
      ticker,
      winRate: Math.round(s.wins / s.total * 100),
      total: s.total,
      wilsonLower: wilsonLowerBound(s.wins, s.total),
      section: s.section,
    }))
    .sort((a, b) => b.wilsonLower - a.wilsonLower || b.total - a.total)
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

  // Calibration: does a higher confidence star rating actually correlate
  // with a higher realized hit rate? Deliberately NOT the same per-prediction
  // `correct` used everywhere else: that field averages every named ticker
  // in a prediction into one win/loss, so a confident, well-sourced call
  // bundled with several weaker "sympathy" tickers gets dragged down by
  // them, and since basket size itself rises with confidence (2026-10 audit
  // found ~2.3 tickers/prediction at 1-star vs ~6.9 at 4-star), that
  // dilution lands harder on exactly the buckets this chart is supposed to
  // show improving — the per-prediction view showed confidence calibration
  // as flat/inverted even though the per-ticker signal below rises cleanly.
  // Counting each named ticker's own raw directional hit (or, for a
  // prediction-market lean with no basket concept, the single call's
  // correct) removes that confound. Buckets under MIN_CALIBRATION_N are
  // flagged insufficient rather than shown as a misleading point estimate.
  // Raw 4 and 5 stars are merged into one bucket: the rubric makes 5 so hard
  // to earn (multiple high-grade sources agreeing, or near-universal
  // precedent) that it never accumulates enough volume to stand alone.
  const MIN_CALIBRATION_N = 10;
  const calibrationBuckets = {};
  for (const p of validated ?? []) {
    const stars = p.analysis?.confidence_weight ?? _parseConfidenceStars(p.analysis?.confidence);
    const bucket = Math.min(4, Math.max(1, Math.round(stars)));
    if (!calibrationBuckets[bucket]) calibrationBuckets[bucket] = { n: 0, hits: 0 };
    const b = calibrationBuckets[bucket];
    if (p.lean) {
      b.n++;
      if (p.correct) b.hits++;
      continue;
    }
    const moves = Object.values(p.analysis?.ticker_moves || {}).filter(m => typeof m.pct === 'number');
    for (const m of moves) {
      b.n++;
      if (m.direction === 'bullish' ? m.pct >= HIT_THRESHOLD_PCT : m.pct <= -HIT_THRESHOLD_PCT) b.hits++;
    }
  }
  const calibration = [1, 2, 3, 4].map(confidence => {
    const b = calibrationBuckets[confidence] || { n: 0, hits: 0 };
    const sufficient = b.n >= MIN_CALIBRATION_N;
    return {
      confidence,
      n: b.n,
      realizedAccuracy: sufficient ? Math.round(b.hits / b.n * 100) : null,
      sufficient,
    };
  });

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

  const pmEdge = await _pmEdgeStats(validated, supabase);

  return res.status(200).json({
    summary: {
      total, correct, incorrect: total - correct, accuracy, accuracyCI, rawAccuracy, rawAccuracyCI,
      pending: (pending ?? 0) - (pendingBaselineCount ?? 0), failed: failedCount ?? 0, totalInDb: totalInDb ?? 0,
      // Platform-wide pending count (organic + baseline-generated) — the
      // "X pending, graded every 2 hours" banner is about system state, not
      // the accuracy headline, so it stays unsegmented unlike `pending` above.
      totalPending: pending ?? 0,
      legacyCount,
    },
    // Auto-generated, no-news/no-source baseline predictions (see
    // api/generate-baseline.js), kept fully separate from the headline
    // summary above rather than blended into it — see the comment where
    // organicValidated/baselineValidated are split.
    baselineGenerated: { ...baselineSummary, pending: pendingBaselineCount ?? 0 },
    timeline, cumulativeTimeline, bySection, byCategory, topTickers, calibration, pmEdge,
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
      yesProbability: p.analysis?.yes_probability ?? null,
      predictedOutcome: p.analysis?.predicted_outcome || null,
      analysis: { resolved_outcome: p.analysis?.resolved_outcome || null },
      // null (no scoring_version at all) means this was graded before
      // benchmark-relative scoring existed — see legacyCount above.
      scoringVersion: p.lean ? null : (p.analysis?.scoring_version ?? null),
      baselineGenerated: !!p.analysis?.baseline_generated,
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

  // Pending PM predictions at least 1 day old (avoid grading same-day
  // predictions) whose market has reached its end date, most recently ended
  // first. Oldest-first used to spend the whole 25-row budget every day on the
  // same long-dated markets that couldn't possibly be decided yet.
  const oneDayAgo = new Date(nowMs - 86400000).toISOString();
  const { data: pending, error } = await supabase
    .from('predictions')
    .select('id, topic, created_at, lean, lean_confidence, analysis, market_slug, category, market_odds_at_time')
    .is('correct', null)
    .not('lean', 'is', null)
    .lt('created_at', oneDayAgo)
    .or(`validation_date.is.null,validation_date.lte.${nowStr}`)
    .order('validation_date', { ascending: false, nullsFirst: false })
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
      const mkt = _pickPmMarket(await _fetchPmEvent(pred.market_slug), topic);
      if (mkt?.question) marketQuestion = mkt.question; // e.g. "Will the Cavaliers win Game 3?"
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
          status:          'resolved',
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
        .eq('id', pred.id)
        .is('correct', null);

      if (!updateErr) {
        graded++;
        results.push({ id: pred.id, topic: pred.topic, lean, outcome: assessment.outcome, correct: leanCorrect });
      }
    } catch (_) { /* skip on error, retry tomorrow */ }
  }

  return res.status(200).json({ graded, checked: pending.length, results });
}

// ── Track record: hit rate per section × confidence level ────────────────────
// What the UI shows instead of confidence stars on stock/crypto calls: "calls
// like this have been right N% of the time". Buckets under
// MIN_TRACK_RECORD_N come back with hitRate null so the UI hides the number
// rather than showing a noisy one. Small payload, CDN-cached for an hour.
const MIN_TRACK_RECORD_N = 20;

// Split by horizon too: a 24-hour call and a 3-month call at the same
// confidence level can have very different track records. 'short' is up to a
// week between the call and its check date, 'long' anything longer.
const SHORT_HORIZON_MS = 7.5 * 86400000;
function _horizonOf(p) {
  if (!p.validation_date || !p.created_at) return null;
  return new Date(p.validation_date) - new Date(p.created_at) <= SHORT_HORIZON_MS ? 'short' : 'long';
}

async function handleTrackRecord(req, res, supabase) {
  const buckets = {}; // section -> level -> { n, correct, byHorizon: { short|long: { n, correct } } }
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await supabase
      .from('predictions')
      .select('category, lean, correct, created_at, validation_date, cw:analysis->confidence_weight, conf:analysis->>confidence')
      .not('correct', 'is', null)
      .range(from, from + 999);
    if (error) throw error;
    for (const p of data || []) {
      if (p.lean) continue; // PM calls show their own probability instead
      const section = _categoryToSection(p.category || 'any');
      const level = Math.min(5, Math.max(1, Math.round(p.cw ?? _parseConfidenceStars(p.conf))));
      const b = ((buckets[section] ||= {})[level] ||= { n: 0, correct: 0, byHorizon: {} });
      b.n++;
      if (p.correct) b.correct++;
      const horizon = _horizonOf(p);
      if (horizon) {
        const h = (b.byHorizon[horizon] ||= { n: 0, correct: 0 });
        h.n++;
        if (p.correct) h.correct++;
      }
    }
    if (!data || data.length < 1000) break;
  }
  const out = {};
  for (const [section, levels] of Object.entries(buckets)) {
    out[section] = {};
    for (const [level, b] of Object.entries(levels)) {
      const rate = x => (x.n >= MIN_TRACK_RECORD_N ? Math.round(x.correct / x.n * 100) : null);
      out[section][level] = {
        n: b.n, hitRate: rate(b),
        byHorizon: Object.fromEntries(Object.entries(b.byHorizon).map(([h, x]) => [h, { n: x.n, hitRate: rate(x) }])),
      };
    }
  }
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ minN: MIN_TRACK_RECORD_N, sections: out });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(200).end();

  let supabase;
  try { supabase = getSupabase({ required: true }); } catch (e) {
    console.error('[predictions]', e);
    return res.status(500).json({ error: 'Database configuration error' });
  }

  try {
    if (req.method === 'POST')                       return res.status(405).json({ error: 'Method not allowed' });
    if (req.query.resolve === 'true' || req.query['news-grade'] === 'true') {
      if (!_isAuthorizedForGrading(req)) return res.status(401).json({ error: 'Unauthorized' });
      if (req.query.resolve === 'true')              return await handleResolve(req, res, supabase);
      return await handleNewsGrade(req, res, supabase);
    }
    if (req.query.graph        === 'true')           return await handleGraph(req, res, supabase);
    if (req.query['track-record'] === 'true')        return await handleTrackRecord(req, res, supabase);
    if (req.method === 'GET')                        return await handleStats(req, res, supabase);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[predictions]', err.message);
    return res.status(500).json({ error: 'Failed to load predictions' });
  }
}
