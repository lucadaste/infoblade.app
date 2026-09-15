import { describe, it, expect } from 'vitest';
import { wilsonInterval, wilsonIntervalFromP, wilsonLowerBound } from './stats.js';

describe('wilsonInterval', () => {
  it('is centered near p for a large n', () => {
    const { lower, upper } = wilsonInterval(500, 1000);
    expect(lower).toBeGreaterThan(0.46);
    expect(upper).toBeLessThan(0.54);
  });

  it('is much wider for a small n at the same raw rate', () => {
    const small = wilsonInterval(1, 2);
    const large = wilsonInterval(500, 1000);
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    expect(smallWidth).toBeGreaterThan(largeWidth);
  });

  it('returns a zero-width interval at n=0 rather than dividing by zero', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 0, center: 0 });
  });

  it('never exceeds [0, 1]', () => {
    const { lower, upper } = wilsonInterval(5, 5);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
  });
});

describe('wilsonLowerBound — leaderboard ranking', () => {
  it('ranks a large sample above a small perfect sample at a slightly lower raw rate', () => {
    // 40/50 = 80% raw vs 5/5 = 100% raw
    const largeSample = wilsonLowerBound(40, 50);
    const smallSample = wilsonLowerBound(5, 5);
    expect(largeSample).toBeGreaterThan(smallSample);
  });
});

describe('wilsonIntervalFromP', () => {
  it('agrees with wilsonInterval when p = successes / n', () => {
    const fromCount = wilsonInterval(30, 100);
    const fromP = wilsonIntervalFromP(0.3, 100);
    expect(fromP.lower).toBeCloseTo(fromCount.lower, 10);
    expect(fromP.upper).toBeCloseTo(fromCount.upper, 10);
  });
});
