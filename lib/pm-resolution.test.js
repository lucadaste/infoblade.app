import { describe, it, expect } from 'vitest';
import { pickPmMarket, pmOutcome, pmWordScore, pmMarketStats } from './pm-resolution.js';

const mkt = (question, prices, uma = 'resolved', volume = '0') =>
  ({ question, outcomePrices: JSON.stringify(prices), umaResolutionStatus: uma, volume });

describe('pickPmMarket', () => {
  const event = {
    markets: [
      mkt('Will Lee Zeldin be the next Attorney General?', ['0', '1'], 'resolved', '485'),
      mkt('Will Todd Blanche be the next Attorney General?', ['1', '0'], 'resolved', '4802'),
    ],
  };

  it('picks the market whose question matches the prediction, not the highest-volume one', () => {
    expect(pickPmMarket(event, 'Will Lee Zeldin be the next Attorney General?').question)
      .toBe('Will Lee Zeldin be the next Attorney General?');
  });

  it('ignores case and whitespace differences', () => {
    expect(pickPmMarket(event, '  will lee zeldin  be the next attorney general? ')).toBe(event.markets[0]);
  });

  it('returns null on a multi-market event with no exact match rather than guessing', () => {
    expect(pickPmMarket(event, 'Who will be the next Attorney General?')).toBeNull();
  });

  it('uses the only market of a single-market event regardless of wording', () => {
    const single = { markets: [mkt('What will be the next Fed rate change?', ['1', '0'])] };
    expect(pickPmMarket(single, 'Fed rate change')).toBe(single.markets[0]);
  });

  it('handles a missing event', () => {
    expect(pickPmMarket(null, 'anything')).toBeNull();
  });
});

describe('pmOutcome', () => {
  it('reads Yes / No from a finalized market', () => {
    expect(pmOutcome(mkt('q', ['1', '0']))).toBe('Yes');
    expect(pmOutcome(mkt('q', ['0', '1']))).toBe('No');
  });

  it('refuses a market the oracle has not finalized, even at an extreme price', () => {
    expect(pmOutcome(mkt('q', ['0.99', '0.01'], 'proposed'))).toBeNull();
    expect(pmOutcome(mkt('q', ['0.99', '0.01'], null))).toBeNull();
  });

  it('refuses an ambiguous finalized price', () => {
    expect(pmOutcome(mkt('q', ['0.5', '0.5']))).toBeNull();
  });

  it('accepts already-parsed outcomePrices and rejects malformed ones', () => {
    expect(pmOutcome({ umaResolutionStatus: 'resolved', outcomePrices: ['0.98', '0.02'] })).toBe('Yes');
    expect(pmOutcome({ umaResolutionStatus: 'resolved', outcomePrices: 'not json' })).toBeNull();
    expect(pmOutcome({ umaResolutionStatus: 'resolved', outcomePrices: ['1'] })).toBeNull();
  });
});

describe('pmWordScore', () => {
  it('scores significant-word overlap, ignoring stop words', () => {
    const { score, matched } = pmWordScore('Will the Packers beat the Falcons?', 'Packers vs Falcons');
    expect(matched).toBe(2);
    expect(score).toBeCloseTo(2 / 3);
  });

  it('returns zero for a question with no significant words', () => {
    expect(pmWordScore('will the', 'anything')).toEqual({ score: 0, matched: 0 });
  });
});

describe('pmMarketStats', () => {
  it('converts Gamma price deltas to percentage points', () => {
    const s = pmMarketStats({ oneDayPriceChange: -0.19, oneWeekPriceChange: 0.145, spread: 0.01, volume24hr: 5000, liquidityNum: '1200.5' });
    expect(s).toMatchObject({ change1d: -19, change1w: 14.5, spread: 1, volume24h: 5000, liquidity: 1200.5, change1h: null });
  });

  it('returns null when the market is missing or has no stats', () => {
    expect(pmMarketStats(null)).toBeNull();
    expect(pmMarketStats({ question: 'x' })).toBeNull();
  });
});
