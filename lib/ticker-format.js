// Shared shape check for a US-listed ticker/ETF symbol: 1-7 chars, uppercase
// letters plus '^' (indices like ^GSPC) and '.' (class shares like BRK.B).
// Pulled out of api/predictions.js's resolver (which only used it to decide
// what to fetch price history for) so api/analyze.js can reject a malformed
// "ticker" — a full company name, a made-up proxy string — at creation time
// instead of silently storing it; the resolver was already dropping anything
// that failed this shape from grading, just invisibly, well after the fact
// (see the 2026-10 grading audit).
const TICKER_RE = /^[A-Z^.]{1,7}$/;

export function isValidTickerFormat(t) {
  return TICKER_RE.test(t);
}
