// Bump whenever the scoring FORMULA changes (hit threshold, hit-rate bonus
// shape, alpha-adjustment, clamp behavior, etc.) — NOT for bug fixes that
// just correct a miscalculation of the existing formula. Stored on every
// graded prediction (analysis.scoring_version) so historical rows scored
// under an older formula stay distinguishable from ones scored under a
// newer one; aggregate stats and comparisons should account for a mixed
// population rather than silently averaging across formula versions.
export const SCORING_VERSION = 3;

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
//
// Scoring is benchmark-relative (alpha-adjusted) when a benchmark return is
// available (see lib/benchmarks.js and computeAccuracyScore below): a call
// that only moved with a broad market/crypto rally, without beating the
// benchmark, doesn't score as demonstrating real insight.

// Per-ticker score: signed % return * 10, clamped to [-100, 100].
// +10% correct call = +100 pts; 5% wrong call = -50 pts.
export function tickerScore(pct, direction) {
  const signed = direction === 'bullish' ? pct : -pct;
  return +(Math.max(-100, Math.min(100, signed * 10)).toFixed(1));
}

// A ticker call counts as a "hit" if it moved >= 2% the predicted direction.
export const HIT_THRESHOLD_PCT = 2;

// Hit-rate bonus: rewards getting direction right on more tickers, roughly
// -10 to +10 pts. Uses a shrinkage estimate (weak Bayesian prior centered at
// 0.5: priorHits=2, priorTotal=4) rather than the raw hit rate, so a 1/1
// prediction doesn't carry the same bonus magnitude as 4/6 at the same raw
// rate — the 6-ticker case is much stronger statistical evidence of the same
// underlying hit rate and should be trusted more. A 1/1 shrinks to 60%
// (bonus +2) instead of reading as a full 100% (bonus +10).
const PRIOR_HITS  = 2;
const PRIOR_TOTAL = 4;
export function hitRateBonus(hitCount, totalCount) {
  if (!totalCount) return 0;
  const adjustedHitRate = (hitCount + PRIOR_HITS) / (totalCount + PRIOR_TOTAL);
  return +((adjustedHitRate - 0.5) * 20).toFixed(1);
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
// moves: { TICKER: { pct, direction: 'bullish'|'bearish', alphaPct? } }.
//
// `pct` is the ticker's own raw % return over the window. `alphaPct` — when
// a benchmark return was available (see lib/benchmarks.js) — is pct minus
// the benchmark's return over the same window: how much the ticker beat (or
// lagged) the market/crypto benchmark, not just whether it moved. Alpha
// drives the primary score/correct/grade so a call doesn't score "correct"
// just for riding a broad rally; the raw, non-alpha score is computed too
// and kept alongside (rawAccuracyScore etc.) rather than discarded, so it
// stays comparable to how predictions were scored before this existed.
// When alphaPct is omitted (no benchmark available for that ticker), it
// defaults to pct — i.e. no adjustment, same as the raw score.
//
// Returns null if there are no gradeable ticker moves.
export function computeAccuracyScore(tickerMovesInput) {
  const entries = Object.entries(tickerMovesInput || {});
  if (!entries.length) return null;

  const tickerMoves = {};
  for (const [t, m] of entries) {
    const alphaPct = m.alphaPct ?? m.pct;
    const pts    = tickerScore(alphaPct, m.direction); // alpha-based — drives correct/outcome/grade
    const rawPts = tickerScore(m.pct, m.direction);    // raw — kept for reference only
    const hit    = m.direction === 'bullish' ? alphaPct >= HIT_THRESHOLD_PCT : alphaPct <= -HIT_THRESHOLD_PCT;
    tickerMoves[t] = { ...m, alphaPct, pts, rawPts, correct: hit };
  }

  const moves        = Object.values(tickerMoves);
  const scores        = moves.map(m => m.pts);
  const rawScores      = moves.map(m => m.rawPts);
  const hitCount      = moves.filter(m => m.correct).length;
  const hitBonus      = hitRateBonus(hitCount, scores.length);
  const avgScore      = +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
  const rawAvgScore   = +(rawScores.reduce((a, b) => a + b, 0) / rawScores.length).toFixed(1);
  const rawClassified = classifyScore(rawAvgScore + hitBonus);

  return {
    tickerMoves, avgScore, hitBonus,
    rawAvgScore,
    rawAccuracyScore: rawClassified.accuracyScore,
    rawCorrect:       rawClassified.correct,
    rawGrade:         rawClassified.grade,
    ...classifyScore(avgScore + hitBonus),
  };
}
