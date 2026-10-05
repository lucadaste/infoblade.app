/**
 * Shared low-level fetch+parse for Yahoo Finance's unauthenticated v8 chart
 * endpoint. Pulled out after lib/quant-signals.js and api/predictions.js's
 * grading resolver (_fetchTickerHistory) ended up with two near-identical
 * copies of this exact fetch — same URL shape, same adjclose-preference
 * logic, same error handling — which is exactly the drift risk this
 * codebase already pulled lib/confidence.js and lib/benchmarks.js out to
 * avoid elsewhere. Callers shape the raw {timestamps, closes} into whatever
 * they need (a date-keyed map for grading, a plain trailing-N-days array
 * for live signals) — this module only owns the fetch and the
 * adjclose-vs-raw-close choice.
 */
import { COIN_SYMS } from './coin-symbols.js';

/**
 * @param {string} ticker - raw symbol (coin suffix handled internally)
 * @param {number} period1 - Unix seconds, range start
 * @param {number} period2 - Unix seconds, range end
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{timestamps: number[], closes: number[], meta: object}|null>} null on
 *   any fetch/parse failure or missing result — callers treat that as
 *   best-effort absence, not an error.
 */
export async function fetchYahooChartSeries(ticker, period1, period2, { timeoutMs = 12000 } = {}) {
  const yTicker = COIN_SYMS.has(ticker) ? `${ticker}-USD` : ticker;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?interval=1d&period1=${period1}&period2=${period2}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Logged on every failure path — previously swallowed to null with no
    // trace, which made a benchmark (SPY/BTC) fetch failure during grading
    // undiagnosable after the fact: every prediction in that resolve batch
    // silently lost its alpha adjustment with nothing in the logs to explain
    // why. See the 2026-10 grading audit.
    if (!r.ok) { console.error('[yahoo-chart] non-OK response', { ticker: yTicker, status: r.status }); return null; }
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) { console.error('[yahoo-chart] no result in response', { ticker: yTicker, error: d?.chart?.error }); return null; }
    const timestamps = result.timestamp || result.timestamps || [];
    // Prefer adjusted close: raw close shows a stock split or ex-dividend date
    // as a fake large price move, which would corrupt both grading's
    // pct_return scoring and the quant signals' momentum/RSI/volatility
    // reads for any ticker with a split/big dividend during the window.
    const closes = result.indicators?.adjclose?.[0]?.adjclose
                || result.indicators?.quote?.[0]?.close || [];
    return { timestamps, closes, meta: result.meta || {} };
  } catch (err) {
    console.error('[yahoo-chart] fetch threw', { ticker: yTicker, error: err?.message || String(err) });
    return null;
  }
}
