// Benchmark mapping for alpha-adjusted scoring (lib/scoring.js). A raw-return
// score rewards a call that happened to move with a broad market/crypto rally
// even when the named ticker underperformed its benchmark — i.e. it can score
// a "correct, positive" call for beta exposure rather than the specific
// insight actually claimed. Alpha = ticker_return - benchmark_return strips
// that out.
//
// Kept as its own module (not inlined in lib/scoring.js) so the mapping is
// easy to find and extend per sector/asset class without touching scoring
// logic itself.

export const STOCK_BENCHMARK  = 'SPY';
export const CRYPTO_BENCHMARK = 'BTC';

// Tickers that ARE the benchmark for their asset class: comparing SPY to SPY
// (or BTC to BTC) always yields alpha = 0, which would zero out every such
// prediction's score regardless of actual performance. These fall back to
// raw return instead of a self-comparison.
const SELF_BENCHMARK_EXEMPT = new Set([STOCK_BENCHMARK, CRYPTO_BENCHMARK]);

// Returns the benchmark ticker to compare `ticker` against, or null if no
// benchmark adjustment should apply (self-exempt, or an unrecognized asset
// class). `isCrypto` should come from the same COIN_SYMS check used
// elsewhere (api/predictions.js) to decide Yahoo's -USD suffix.
export function benchmarkFor(ticker, isCrypto) {
  if (SELF_BENCHMARK_EXEMPT.has(ticker)) return null;
  return isCrypto ? CRYPTO_BENCHMARK : STOCK_BENCHMARK;
}

// All distinct benchmark tickers this module can return — used to make sure
// their price history gets fetched alongside the predicted tickers.
export const ALL_BENCHMARKS = [STOCK_BENCHMARK, CRYPTO_BENCHMARK];
