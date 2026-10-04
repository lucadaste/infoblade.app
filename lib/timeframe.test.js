import { describe, it, expect } from 'vitest';
import { parseTimeframeDays } from './timeframe.js';

describe('parseTimeframeDays — leftmost number-adjacent-to-a-unit wins', () => {
  it('parses a bare month string', () => {
    expect(parseTimeframeDays('3 months')).toBe(90);
  });

  it('does not let a parenthetical trading-day conversion override a month-scale horizon', () => {
    expect(parseTimeframeDays('Over the next 3 months (approximately 65 trading days)')).toBe(90);
  });

  it('does not let a parenthetical trading-day conversion override a week-scale horizon', () => {
    expect(parseTimeframeDays('Over the next 2-4 weeks (approximately 10-20 trading days)')).toBe(21);
  });

  it('still parses a genuine day-scale window with no larger unit present', () => {
    expect(parseTimeframeDays('Over the next 1-7 days')).toBe(4);
  });

  it('still parses a genuine hour-scale window with no larger unit present', () => {
    expect(parseTimeframeDays('Immediate within 48 hours')).toBe(2);
  });

  it('prefers a day-scale primary unit over a parenthetical hour conversion', () => {
    expect(parseTimeframeDays('2-3 days (48-72 hours)')).toBe(3);
  });

  it('ignores a later unit word that has no number directly in front of it', () => {
    // "weeks" appears later with its number AFTER the word ("weeks 6-10"),
    // so it must not be mistaken for the stated "60-90 days" horizon.
    expect(parseTimeframeDays(
      'Over the next 60-90 days, with peak momentum likely in weeks 6-10 as BTC consolidates and capital rotates into higher-beta assets'
    )).toBe(75);
  });

  it('parses a month range, rounding within the unit before converting to days', () => {
    // avg(2,3) rounds to 3 months (round-half-up, same as the original
    // per-branch behavior) -> 90 days, which is also what the parenthetical
    // "90-day horizon" independently says.
    expect(parseTimeframeDays('Over the next 2-3 months (90-day horizon)')).toBe(90);
  });
});
