import { describe, it, expect } from 'vitest';
import { tickerScore, hitRateBonus, classifyScore, computeAccuracyScore, HIT_THRESHOLD_PCT } from './scoring.js';

describe('tickerScore', () => {
  it('scores a bullish call by its raw % return * 10', () => {
    expect(tickerScore(5, 'bullish')).toBe(50);
  });

  it('flips sign for a bearish call (down move is a correct bearish call)', () => {
    expect(tickerScore(-5, 'bearish')).toBe(50);
  });

  it('clamps above +100', () => {
    expect(tickerScore(50, 'bullish')).toBe(100);
  });

  it('clamps below -100', () => {
    expect(tickerScore(-50, 'bullish')).toBe(-100);
  });
});

describe('classifyScore — the score === 0 boundary bug', () => {
  it('maps a positive score to outcome "correct" and correct=true', () => {
    const r = classifyScore(10);
    expect(r.correct).toBe(true);
    expect(r.outcome).toBe('correct');
  });

  it('maps a negative score to outcome "incorrect" and correct=false', () => {
    const r = classifyScore(-10);
    expect(r.correct).toBe(false);
    expect(r.outcome).toBe('incorrect');
  });

  it('maps exactly 0 to a neutral outcome, and — the original bug — the letter grade never disagrees with `correct`', () => {
    const r = classifyScore(0);
    expect(r.outcome).toBe('neutral');
    expect(r.correct).toBe(false);
    // Old behavior: _letterGrade(0) returned 'C' (score >= 0) while
    // correct was accuracyScore > 0 = false — a "C" shown as incorrect.
    // The grade boundary is now > 0 too, so a false `correct` can never
    // be paired with a passing-looking grade.
    expect(r.grade).not.toBe('C');
    expect(r.grade).not.toBe('B');
    expect(r.grade).not.toBe('A');
  });

  it('clamps a raw score before classifying, even if the input exceeds +/-100', () => {
    const r = classifyScore(150);
    expect(r.accuracyScore).toBe(100);
    const r2 = classifyScore(-150);
    expect(r2.accuracyScore).toBe(-100);
  });
});

describe('hitRateBonus (sample-size-aware shrinkage toward 0.5)', () => {
  it('is 0 at exactly 50% hit rate regardless of sample size', () => {
    expect(hitRateBonus(1, 2)).toBe(0);
    expect(hitRateBonus(3, 6)).toBe(0);
  });

  it('shrinks a small-n 100% hit rate well below the raw +10 bonus', () => {
    // raw formula would give (1 - 0.5) * 20 = +10 for 1/1
    const bonus = hitRateBonus(1, 1);
    expect(bonus).toBeLessThan(10);
    expect(bonus).toBeGreaterThan(0);
  });

  it('a larger sample at a given rate is trusted more than a tiny sample at the same raw rate', () => {
    // 5/6 (~83%) is much stronger evidence than 1/1 (100%) despite the lower raw rate
    const smallSample = hitRateBonus(1, 1);
    const largerSample = hitRateBonus(5, 6);
    expect(largerSample).toBeGreaterThan(smallSample);
  });

  it('a larger sample approaches the raw hit rate more closely than a tiny sample does', () => {
    // raw 66.7% -> (0.667-0.5)*20 = 3.33; shrunk toward 0.5 but less so than a 1-ticker case
    const bonus4of6 = hitRateBonus(4, 6);
    expect(bonus4of6).toBeGreaterThan(0);
    expect(bonus4of6).toBeLessThan(3.33);
  });

  it('is 0 for an empty sample (no divide-by-zero)', () => {
    expect(hitRateBonus(0, 0)).toBe(0);
  });
});

describe('computeAccuracyScore — alpha adjustment', () => {
  it('falls back to raw return when alphaPct is not provided (no benchmark available)', () => {
    const r = computeAccuracyScore({ AAPL: { pct: 8, direction: 'bullish' } });
    expect(r.tickerMoves.AAPL.alphaPct).toBe(8);
    expect(r.tickerMoves.AAPL.pts).toBe(r.tickerMoves.AAPL.rawPts);
  });

  it('a bullish call that only matched the benchmark (alpha=0) does not score as correct even though raw return was positive', () => {
    // ticker +8%, benchmark also +8% -> alpha 0. Raw would score this as a
    // clear beta-only "win"; alpha correctly treats it as no demonstrated edge.
    const r = computeAccuracyScore({
      AAPL: { pct: 8, alphaPct: 0, direction: 'bullish' },
    });
    expect(r.tickerMoves.AAPL.correct).toBe(false); // alpha=0 doesn't clear HIT_THRESHOLD_PCT
    expect(r.rawAccuracyScore).toBeGreaterThan(0);   // but the raw score still reads as a win
    expect(r.rawCorrect).toBe(true);
  });

  it('a ticker that beat its benchmark scores as correct even if its raw return alone was negative', () => {
    // ticker -3%, benchmark -10% -> alpha +7%: genuinely beat the market
    // despite a negative raw return.
    const r = computeAccuracyScore({
      AAPL: { pct: -3, alphaPct: 7, direction: 'bullish' },
    });
    expect(r.correct).toBe(true);
    expect(r.rawCorrect).toBe(false); // raw return alone was negative
  });

  it('keeps the raw (non-alpha) score alongside the primary alpha-based one, not discarded', () => {
    const r = computeAccuracyScore({ AAPL: { pct: 8, alphaPct: 0, direction: 'bullish' } });
    expect(r.rawAccuracyScore).not.toBeUndefined();
    expect(r.rawGrade).not.toBeUndefined();
  });
});

describe('computeAccuracyScore', () => {
  it('returns null when there are no ticker moves', () => {
    expect(computeAccuracyScore({})).toBeNull();
    expect(computeAccuracyScore(null)).toBeNull();
  });

  it('combines multiple tickers into one aggregate score', () => {
    // AAPL: +5% bullish -> pts 50, hit (>= 2%)
    // TSLA: -1% bullish -> pts -10, miss
    // avgScore = (50 + -10) / 2 = 20; hitRate = 1/2 -> hitBonus = 0
    const r = computeAccuracyScore({
      AAPL: { pct: 5, direction: 'bullish' },
      TSLA: { pct: -1, direction: 'bullish' },
    });
    expect(r.avgScore).toBe(20);
    expect(r.hitBonus).toBe(0);
    expect(r.accuracyScore).toBe(20);
    expect(r.correct).toBe(true);
  });

  it('applies the hit threshold consistently (>= 2% counts as a hit)', () => {
    const r = computeAccuracyScore({ AAPL: { pct: HIT_THRESHOLD_PCT, direction: 'bullish' } });
    expect(r.tickerMoves.AAPL.correct).toBe(true);
    const r2 = computeAccuracyScore({ AAPL: { pct: HIT_THRESHOLD_PCT - 0.01, direction: 'bullish' } });
    expect(r2.tickerMoves.AAPL.correct).toBe(false);
  });

  it('an aggregate that nets to exactly 0 resolves to the neutral, non-contradictory outcome', () => {
    // AAPL: -2% bullish -> pts -20, miss. TSLA: +2% bullish -> pts +20, hit.
    // avgScore = 0, hitRate = 1/2 -> hitBonus = 0 -> accuracyScore = 0.
    const r = computeAccuracyScore({
      AAPL: { pct: -2, direction: 'bullish' },
      TSLA: { pct: 2, direction: 'bullish' },
    });
    expect(r.accuracyScore).toBe(0);
    expect(r.outcome).toBe('neutral');
    expect(r.correct).toBe(false);
  });
});
