// Bump whenever the scoring FORMULA changes (hit threshold, hit-rate bonus
// shape, alpha-adjustment, clamp behavior, etc.) — NOT for bug fixes that
// just correct a miscalculation of the existing formula. Stored on every
// graded prediction (analysis.scoring_version) so historical rows scored
// under an older formula stay distinguishable from ones scored under a
// newer one; aggregate stats and comparisons should account for a mixed
// population rather than silently averaging across formula versions.
export const SCORING_VERSION = 1;

// Canonical scoring module for stock/crypto ticker-based predictions.
//
// Before this existed, "correct" was computed independently in three places
// with three different thresholds (accuracyScore > 0 in the live resolver,
// pct >= 0.5% in the now-deleted api/validate.js, and a separate score > -15
// "lenient" threshold for section stats) and the letter-grade boundary could
// disagree with the correct/incorrect boolean at score === 0 (grade "C" shown
// as incorrect). Everything that needs a score, grade, or correct/incorrect
// call for a stock/crypto prediction should go through computeAccuracyScore
// below instead of re-deriving it.
//
// Prediction-market (Polymarket) grading is a separate binary A/F system
// (see _pmScore/_pmGrade/_pmWeight in api/predictions.js) — it was never part
// of the "correct" inconsistency, so it isn't handled here.

// Per-ticker score: signed % return * 10, clamped to [-100, 100].
// +10% correct call = +100 pts; 5% wrong call = -50 pts.
export function tickerScore(pct, direction) {
  const signed = direction === 'bullish' ? pct : -pct;
  return +(Math.max(-100, Math.min(100, signed * 10)).toFixed(1));
}

// A ticker call counts as a "hit" if it moved >= 2% the predicted direction.
export const HIT_THRESHOLD_PCT = 2;

// Hit-rate bonus: rewards getting direction right on more tickers, -10 to +10 pts.
// TODO(phase 3.3): make this sample-size-aware (shrink small-n hit rates toward
// 0.5) so a 1/1 prediction doesn't carry the same bonus magnitude as 4/6 at the
// same raw rate. Isolated behind this function specifically so that swap is a
// one-line change with no call sites to hunt down.
export function hitRateBonus(hitCount, totalCount) {
  if (!totalCount) return 0;
  const hitRate = hitCount / totalCount;
  return +((hitRate - 0.5) * 20).toFixed(1);
}

// Single shared letter-grade mapping. Boundary is set at score > 0 (not >= 0)
// specifically so it can never disagree with `correct` (also > 0) the way the
// old >= 0 boundary did for an exact score of 0.
function letterGrade(score) {
  if (score >= 60) return 'A';
  if (score >= 25) return 'B';
  if (score > 0)   return 'C';
  if (score >= -25) return 'D';
  return 'F';
}

// score === 0 is a wash: the call demonstrated no directional edge. It's
// deliberately NOT "correct" (no insight was confirmed) but is tagged
// `outcome: 'neutral'` rather than lumped in silently with genuine misses —
// analysis.outcome carries that distinction even though `correct` (used for
// aggregate accuracy %) stays false for both.
export function classifyScore(rawScore) {
  const accuracyScore = +Math.max(-100, Math.min(100, rawScore)).toFixed(1);
  const outcome = accuracyScore > 0 ? 'correct' : accuracyScore < 0 ? 'incorrect' : 'neutral';
  return {
    accuracyScore,
    correct: outcome === 'correct',
    outcome,
    grade: letterGrade(accuracyScore),
  };
}

// Computes the full accuracy score for a prediction from its resolved ticker
// moves: { TICKER: { pct, direction: 'bullish'|'bearish' } }.
// Returns null if there are no gradeable ticker moves.
export function computeAccuracyScore(tickerMovesInput) {
  const entries = Object.entries(tickerMovesInput || {});
  if (!entries.length) return null;

  const tickerMoves = {};
  for (const [t, m] of entries) {
    const pts = tickerScore(m.pct, m.direction);
    const hit = m.direction === 'bullish' ? m.pct >= HIT_THRESHOLD_PCT : m.pct <= -HIT_THRESHOLD_PCT;
    tickerMoves[t] = { ...m, pts, correct: hit };
  }

  const scores    = Object.values(tickerMoves).map(m => m.pts);
  const hitCount  = Object.values(tickerMoves).filter(m => m.correct).length;
  const hitBonus  = hitRateBonus(hitCount, scores.length);
  const avgScore  = +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);

  return { tickerMoves, avgScore, hitBonus, ...classifyScore(avgScore + hitBonus) };
}
