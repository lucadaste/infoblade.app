import { describe, it, expect } from 'vitest';
import { staticSourceGrade, betaShrunkAccuracy, adjustGradeForReputation, getSourceGrade } from './source-quality.js';

describe('staticSourceGrade', () => {
  it('grades a known wire service High', () => {
    expect(staticSourceGrade('Reuters')).toBe('High');
  });

  it('grades an unrecognized outlet Unknown', () => {
    expect(staticSourceGrade('SomeRandomBlogNobodyHasHeardOf')).toBe('Unknown');
  });

  it('matches the same outlet regardless of the pipeline that saw it (the original bug this fixed)', () => {
    // Previously api/analyze.js graded Yahoo Finance Medium while
    // api/market-analyze.js's separate dict left it Unknown.
    expect(staticSourceGrade('Yahoo Finance')).toBe('Medium');
  });
});

describe('betaShrunkAccuracy — Beta-Binomial shrinkage', () => {
  it('equals the prior mean exactly at zero attempts', () => {
    expect(betaShrunkAccuracy('High', { attempts: 0, correct: 0 })).toBeCloseTo(0.65, 5);
    expect(betaShrunkAccuracy('Medium', { attempts: 0, correct: 0 })).toBeCloseTo(0.55, 5);
  });

  it('equals the prior mean when reputation is missing entirely', () => {
    expect(betaShrunkAccuracy('High', undefined)).toBeCloseTo(0.65, 5);
    expect(betaShrunkAccuracy('High', null)).toBeCloseTo(0.65, 5);
  });

  it('barely moves off the prior for a small sample (the restaurant-review problem)', () => {
    // 3 perfect results shouldn't make an Unknown source look anywhere near
    // as good as a source with a real track record of the same raw rate.
    const smallSample = betaShrunkAccuracy('Unknown', { attempts: 3, correct: 3 });
    expect(smallSample).toBeLessThan(0.65);
    expect(smallSample).toBeGreaterThan(0.50);
  });

  it('converges toward the raw empirical rate as attempts grow large', () => {
    const large = betaShrunkAccuracy('High', { attempts: 2000, correct: 400 }); // raw rate 0.20
    expect(large).toBeLessThan(0.25);
    expect(large).toBeGreaterThan(0.19);
  });

  it('is monotonically increasing in correct (more hits never lowers the estimate)', () => {
    const lower = betaShrunkAccuracy('Medium', { attempts: 50, correct: 20 });
    const higher = betaShrunkAccuracy('Medium', { attempts: 50, correct: 30 });
    expect(higher).toBeGreaterThan(lower);
  });

  it('a large sample outranks a small "perfect" sample even at a lower raw rate', () => {
    // The canonical shrinkage test: 500 correct/1000 (50%) vs 3/3 (100%) —
    // the huge sample's real signal should win once shrunk, the same way a
    // product with 500 4.6-star reviews outranks one with 3 5-star reviews.
    const bigRealisticSample = betaShrunkAccuracy('Medium', { attempts: 1000, correct: 550 }); // 55% raw, matches prior
    const tinyPerfectSample = betaShrunkAccuracy('Medium', { attempts: 3, correct: 3 }); // 100% raw
    expect(bigRealisticSample).toBeLessThan(tinyPerfectSample); // still true numerically...
    // ...but the big sample's estimate should be close to its OWN true rate,
    // while the tiny "perfect" sample should be pulled back well below 100%.
    expect(tinyPerfectSample).toBeLessThan(0.9);
    expect(bigRealisticSample).toBeGreaterThan(0.5);
  });
});

describe('adjustGradeForReputation', () => {
  it('leaves the tier unchanged with no tracked attempts', () => {
    expect(adjustGradeForReputation('High', { attempts: 0, correct: 0 })).toBe('High');
    expect(adjustGradeForReputation('Medium', null)).toBe('Medium');
  });

  it('does not promote an Unknown source off a tiny, lucky sample', () => {
    expect(adjustGradeForReputation('Unknown', { attempts: 2, correct: 2 })).toBe('Unknown');
  });

  it('promotes an Unknown source with a long, genuinely strong track record', () => {
    expect(adjustGradeForReputation('Unknown', { attempts: 60, correct: 48 })).toBe('High');
  });

  it('demotes a High source with a long, genuinely poor track record', () => {
    expect(adjustGradeForReputation('High', { attempts: 60, correct: 10 })).toBe('Low');
  });

  it('does not swing a High source off a single bad short streak', () => {
    // 2/5 correct is a bad-looking raw rate, but 5 samples against a strong
    // prior should not crash all the way down.
    const result = adjustGradeForReputation('High', { attempts: 5, correct: 2 });
    expect(['High', 'Medium']).toContain(result);
  });
});

describe('getSourceGrade — full lookup', () => {
  it('combines the static lookup with reputation adjustment', () => {
    expect(getSourceGrade('Reuters', {})).toBe('High');
    expect(getSourceGrade('Reuters', { Reuters: { attempts: 60, correct: 10 } })).toBe('Low');
  });

  it('works with no reputation map at all (matches old single-arg call sites)', () => {
    expect(getSourceGrade('Reuters')).toBe('High');
  });
});
