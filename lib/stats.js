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
