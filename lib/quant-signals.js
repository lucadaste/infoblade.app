/**
 * Medium-horizon quant signals for the stock/crypto prediction prompt
 * (api/analyze.js) — momentum, RSI, relative strength vs. benchmark, and
 * volatility regime computed from daily closes. Deliberately NOT the
 * intraday 5m/15m engine in lib/situation-similarity-stocks.js: these
 * predictions run on a 48-hour-to-months horizon (see impactTimeframe in
 * api/analyze.js), and a 5-minute momentum read is noise at that timescale.
 * This module fetches daily (not minute-level) history instead.
 *
 * Best-effort throughout: Yahoo's chart endpoint is unauthenticated and can
 * rate-limit or omit a symbol. A ticker with insufficient history is simply
 * left out of the snapshot rather than failing the whole batch.
 */
import { COIN_SYMS } from './coin-symbols.js';
import { benchmarkFor } from './benchmarks.js';

const HISTORY_DAYS = 220; // enough calendar days to get ~150 trading days for the volatility-regime lookback

async function _fetchDailyCloses(ticker) {
  const yTicker = COIN_SYMS.has(ticker) ? `${ticker}-USD` : ticker;
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - HISTORY_DAYS * 86400;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?interval=1d&period1=${period1}&period2=${period2}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators?.adjclose?.[0]?.adjclose
                || result.indicators?.quote?.[0]?.close || [];
    const clean = closes.filter(c => c != null);
    return clean.length >= 20 ? clean : null;
  } catch (_) { return null; }
}

// Standard 14-period RSI (Wilder's smoothing is overkill for a cold-start
// single-window read — simple average over the last 14 daily changes).
function _rsi14(closes) {
  if (closes.length < 15) return null;
  const window = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < window.length; i++) {
    const diff = window[i] - window[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / 14, avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(1);
}

function _pctChangeOverTradingDays(closes, days) {
  if (closes.length < days + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - days];
  if (!then) return null;
  return +((now - then) / then * 100).toFixed(2);
}

function _dailyReturns(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return rets;
}

function _stdev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Annualized realized volatility over the trailing `window` trading days.
function _realizedVol(closes, window) {
  if (closes.length < window + 1) return null;
  const rets = _dailyReturns(closes.slice(-(window + 1)));
  const sd = _stdev(rets);
  return sd != null ? +(sd * Math.sqrt(252) * 100).toFixed(1) : null;
}

// Is current 20-day realized vol elevated/normal/low vs. its own trailing
// history? Cheap proxy: sample rolling-20d vol every 5 trading days over the
// prior ~90 days and compare the current reading to that sample's average,
// rather than fetching a second data source for an implied-vol benchmark.
function _volRegime(closes) {
  const current = _realizedVol(closes, 20);
  if (current == null || closes.length < 110) return { current, trailingAvg: null, regime: null };
  const samples = [];
  for (let end = closes.length - 20; end >= closes.length - 110; end -= 5) {
    const v = _realizedVol(closes.slice(0, end + 1), 20);
    if (v != null) samples.push(v);
  }
  if (samples.length < 5) return { current, trailingAvg: null, regime: null };
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const ratio = current / avg;
  const regime = ratio >= 1.3 ? 'elevated' : ratio <= 0.75 ? 'low' : 'normal';
  return { current, trailingAvg: +avg.toFixed(1), regime };
}

/**
 * @param {string[]} tickers
 * @returns {Promise<Record<string, {momentum1w: number|null, momentum1m: number|null,
 *   rsi14: number|null, relStrength1m: number|null, volCurrent: number|null,
 *   volTrailingAvg: number|null, volRegime: 'elevated'|'normal'|'low'|null}>>}
 */
export async function fetchQuantSignals(tickers) {
  if (!tickers?.length) return {};

  // Benchmarks (SPY, BTC) are shared across many tickers in one batch — fetch
  // each distinct one once, not once per ticker.
  const neededBenchmarks = [...new Set(
    tickers.map(t => benchmarkFor(t, COIN_SYMS.has(t))).filter(Boolean)
  )];

  const [tickerCloses, benchmarkCloses] = await Promise.all([
    Promise.all(tickers.map(t => _fetchDailyCloses(t))),
    Promise.all(neededBenchmarks.map(b => _fetchDailyCloses(b))),
  ]);

  const benchmarkMap = {};
  neededBenchmarks.forEach((b, i) => { benchmarkMap[b] = benchmarkCloses[i]; });

  const snapshot = {};
  tickers.forEach((ticker, i) => {
    const closes = tickerCloses[i];
    if (!closes) return;

    const momentum1w = _pctChangeOverTradingDays(closes, 5);
    const momentum1m = _pctChangeOverTradingDays(closes, 21);

    const bench = benchmarkMap[benchmarkFor(ticker, COIN_SYMS.has(ticker))];
    const benchMomentum1m = bench ? _pctChangeOverTradingDays(bench, 21) : null;
    const relStrength1m = momentum1m != null && benchMomentum1m != null
      ? +(momentum1m - benchMomentum1m).toFixed(2)
      : null;

    const { current, trailingAvg, regime } = _volRegime(closes);

    snapshot[ticker] = {
      momentum1w, momentum1m,
      rsi14: _rsi14(closes),
      relStrength1m,
      volCurrent: current, volTrailingAvg: trailingAvg, volRegime: regime,
    };
  });
  return snapshot;
}
