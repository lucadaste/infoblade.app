// Small statistical helpers shared across handleStats (api/predictions.js).
//
// Wilson score interval: a proportion confidence interval that's more robust
// than a plain +/- sqrt(p(1-p)/n) normal approximation for small n or a
// proportion near 0 or 1 — both common here (a ticker resolved only 5 times,
// or a near-100%/near-0% win rate).
export function wilsonInterval(successes, n, z = 1.96) {
  return wilsonIntervalFromP(n ? successes / n : 0, n, z);
}

// Same interval, but starting from an already-computed proportion instead of
// a raw success count — for the headline accuracy number, which is
// confidence-weighted (weightedCorrect / totalWeight), not a plain count.
// The interval is an approximation in that case (Wilson's derivation assumes
// n independent equal-weight Bernoulli trials), using the resolved
// prediction count as n per the product decision to show a ballpark
// uncertainty band rather than a fully rigorous weighted interval.
export function wilsonIntervalFromP(p, n, z = 1.96) {
  if (!n) return { lower: 0, upper: 0, center: 0 };
  p = Math.max(0, Math.min(1, p));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower:  Math.max(0, center - margin),
    upper:  Math.min(1, center + margin),
    center,
  };
}

// Lower bound only — used to rank a leaderboard so a tiny sample at a high
// raw rate (5/5) doesn't automatically outrank a much larger sample at a
// slightly lower raw rate (40/50), which is stronger evidence.
export function wilsonLowerBound(successes, n, z = 1.96) {
  return wilsonInterval(successes, n, z).lower;
}

// Standard normal CDF (Zelen & Severo approximation, ~1e-7 accuracy). Shared by
// twoProportionZTest and pairedDifferenceTest below — one piece of math, not two.
function _normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// Two-proportion z-test (pooled) — is the difference between two accuracy rates
// (e.g. before vs. after a methodology change) large enough to not plausibly be
// chance? Returns null when either sample is too small to trust the normal
// approximation — MIN_TEST_N mirrors MIN_CALIBRATION_N already used for the same
// reason in api/predictions.js. `diff` is successB's rate minus successA's (so a
// negative diff when B is "after" means the newer group scored lower).
const MIN_TEST_N = 10;
export function twoProportionZTest(successA, nA, successB, nB) {
  if (nA < MIN_TEST_N || nB < MIN_TEST_N) return null;
  const pA = successA / nA, pB = successB / nB;
  const pooled = (successA + successB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, pValue: 1, pA, pB, diff: pB - pA, significant: false };
  const z = (pA - pB) / se;
  const pValue = 2 * (1 - _normalCDF(Math.abs(z)));
  return { z, pValue, pA, pB, diff: pB - pA, significant: pValue < 0.05 };
}

// Paired-difference test (normal approximation of a paired t-test — valid once n
// is reasonably large; MIN_PAIRED_N is a more conservative gate than MIN_TEST_N
// since a t-test's normal approximation needs a larger sample than a proportion
// test to be trustworthy). Pass the per-pair differences directly (e.g.
// newTokenCount - oldTokenCount for each paired question) — a negative meanDiff
// means the second condition was smaller on average.
const MIN_PAIRED_N = 20;
export function pairedDifferenceTest(differences) {
  const n = differences.length;
  if (n < MIN_PAIRED_N) return null;
  const mean = differences.reduce((a, b) => a + b, 0) / n;
  const variance = differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return { meanDiff: mean, z: 0, pValue: mean === 0 ? 1 : 0, significant: mean !== 0, n };
  const se = sd / Math.sqrt(n);
  const z = mean / se;
  const pValue = 2 * (1 - _normalCDF(Math.abs(z)));
  return { meanDiff: mean, sd, z, pValue, significant: pValue < 0.05, n };
}
