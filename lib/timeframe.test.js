import { describe, it, expect } from 'vitest';
import { parseTimeframeDays } from './timeframe.js';

describe('parseTimeframeDays — coarsest-unit-first parsing', () => {
  it('parses a bare month string', () => {
    expect(parseTimeframeDays('3 months')).toBe(90);
  });

  it('does not let a parenthetical trading-day conversion collapse a month-scale window', () => {
    expect(parseTimeframeDays('Over the next 3 months (approximately 65 trading days)')).toBe(90);
  });

  it('does not let a parenthetical trading-day conversion collapse a week-scale window', () => {
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
});
