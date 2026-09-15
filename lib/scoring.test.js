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

describe('hitRateBonus', () => {
  it('is 0 at exactly 50% hit rate', () => {
    expect(hitRateBonus(1, 2)).toBe(0);
  });

  it('is +10 at 100% hit rate', () => {
    expect(hitRateBonus(2, 2)).toBe(10);
  });

  it('is -10 at 0% hit rate', () => {
    expect(hitRateBonus(0, 2)).toBe(-10);
  });

  it('is 0 for an empty sample (no divide-by-zero)', () => {
    expect(hitRateBonus(0, 0)).toBe(0);
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
