// Math for scripts/fit-pm-blend.js: does an independent model probability
// add anything on top of the market's own odds? Fits
//   P(YES) = sigmoid(a + b·logit(market) + c·logit(model))
// by logistic regression. c ≈ 0 means the model adds nothing the crowd
// didn't already know; c > 0 is how much weight it earns. Probabilities are
// on a 0-100 scale throughout, matching how they're stored.

const EPS_PCT = 1; // clamp to [1, 99] so 0%/100% don't blow up the logit

export function logit(pct) {
  const p = Math.min(100 - EPS_PCT, Math.max(EPS_PCT, pct)) / 100;
  return Math.log(p / (1 - p));
}

export function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Mean squared error of the YES probability vs the 0/1 outcome (0 = perfect,
// 0.25 = always saying 50%). Same formula as api/predictions.js's pmEdge.
export function brier(probsPct, outcomes) {
  if (!probsPct.length) return null;
  let s = 0;
  for (let i = 0; i < probsPct.length; i++) s += (probsPct[i] / 100 - outcomes[i]) ** 2;
  return s / probsPct.length;
}

// Mean negative log-likelihood; punishes confident misses much harder than Brier.
export function logLoss(probsPct, outcomes) {
  if (!probsPct.length) return null;
  let s = 0;
  for (let i = 0; i < probsPct.length; i++) {
    const p = Math.min(100 - EPS_PCT, Math.max(EPS_PCT, probsPct[i])) / 100;
    s -= outcomes[i] ? Math.log(p) : Math.log(1 - p);
  }
  return s / probsPct.length;
}

// Logistic regression by Newton's method. X: rows of features (no intercept
// column — it's added here), y: 0/1. A small L2 penalty on the slopes (not
// the intercept) keeps it stable on tiny or perfectly-separated samples.
export function fitLogistic(X, y, { l2 = 0.01, iters = 50 } = {}) {
  const k = (X[0]?.length ?? 0) + 1;
  const w = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = [1, ...X[i]];
      const p = sigmoid(x.reduce((s, xj, j) => s + xj * w[j], 0));
      const r = p - y[i], v = p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a] += r * x[a];
        for (let b = 0; b < k; b++) H[a][b] += v * x[a] * x[b];
      }
    }
    for (let a = 1; a < k; a++) { g[a] += l2 * w[a]; H[a][a] += l2; }
    const step = _solve(H, g);
    if (!step) break;
    let maxStep = 0;
    for (let a = 0; a < k; a++) { w[a] -= step[a]; maxStep = Math.max(maxStep, Math.abs(step[a])); }
    if (maxStep < 1e-8) break;
  }
  return w; // [intercept, ...slopes]
}

export function predictLogistic(w, x) {
  return 100 * sigmoid(w[0] + x.reduce((s, xj, j) => s + xj * w[j + 1], 0));
}

// Gaussian elimination with partial pivoting; null if singular.
function _solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// 95% bootstrap interval for brier(a) - brier(b) on the same rows (negative =
// a is better). Seeded so reruns on the same data print the same interval.
export function bootstrapBrierDiff(aPct, bPct, outcomes, { reps = 2000, seed = 1 } = {}) {
  const n = outcomes.length;
  if (!n) return null;
  let state = seed >>> 0 || 1;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const diffs = [];
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rand() * n);
      s += (aPct[j] / 100 - outcomes[j]) ** 2 - (bPct[j] / 100 - outcomes[j]) ** 2;
    }
    diffs.push(s / n);
  }
  diffs.sort((x, y) => x - y);
  return { lower: diffs[Math.floor(reps * 0.025)], upper: diffs[Math.floor(reps * 0.975)] };
}
