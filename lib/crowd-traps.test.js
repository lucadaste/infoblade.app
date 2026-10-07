import { describe, it, expect } from 'vitest';
import { detectCrowdTraps, isFresh, LONGSHOT_MAX_PCT, FRESH_HOURS } from './crowd-traps.js';

const NOW = Date.parse('2026-10-07T18:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();
const keys = t => t.map(x => x.key);

describe('isFresh', () => {
  it('accepts news inside the window and rejects older or unparseable dates', () => {
    expect(isFresh(hoursAgo(1), NOW)).toBe(true);
    expect(isFresh(hoursAgo(FRESH_HOURS + 1), NOW)).toBe(false);
    expect(isFresh(null, NOW)).toBe(false);
    expect(isFresh('not a date', NOW)).toBe(false);
  });
  it('parses RSS-style dates', () => {
    expect(isFresh('Wed, 07 Oct 2026 16:30:00 GMT', NOW)).toBe(true);
  });
});

describe('detectCrowdTraps', () => {
  it('returns nothing for a mid-priced, liquid market with old news', () => {
    const t = detectCrowdTraps({ currentOdds: 55, stats: { liquidity: 50000, volume24h: 20000, change1d: 1 }, news: [{ date: hoursAgo(30) }], nowMs: NOW });
    expect(t).toEqual([]);
  });

  it('flags a longshot on either side and names the cheap side', () => {
    const yes = detectCrowdTraps({ currentOdds: LONGSHOT_MAX_PCT, nowMs: NOW });
    expect(keys(yes)).toEqual(['longshot']);
    expect(yes[0].text).toContain('YES side is priced at 25%');
    const no = detectCrowdTraps({ currentOdds: 90, nowMs: NOW });
    expect(no[0].text).toContain('NO side is priced at 10%');
    expect(keys(detectCrowdTraps({ currentOdds: 26, nowMs: NOW }))).toEqual([]);
  });

  it('flags a thin market on low liquidity or low volume', () => {
    expect(keys(detectCrowdTraps({ currentOdds: 50, stats: { liquidity: 2000, volume24h: 90000 }, nowMs: NOW }))).toEqual(['thin_market']);
    expect(keys(detectCrowdTraps({ currentOdds: 50, stats: { liquidity: 90000, volume24h: 100 }, nowMs: NOW }))).toEqual(['thin_market']);
  });

  it('does not call a market thin when the numbers are missing', () => {
    expect(keys(detectCrowdTraps({ currentOdds: 50, stats: { change1d: 0 }, nowMs: NOW }))).toEqual([]);
  });

  it('flags fresh news only when the odds have barely moved', () => {
    const news = [{ date: hoursAgo(2) }];
    expect(keys(detectCrowdTraps({ currentOdds: 50, stats: { liquidity: 50000, change1d: 1 }, news, nowMs: NOW }))).toEqual(['fresh_news']);
    expect(keys(detectCrowdTraps({ currentOdds: 50, stats: { liquidity: 50000, change1d: -8 }, news, nowMs: NOW }))).toEqual([]);
  });

  it('treats unknown movement as unmoved', () => {
    expect(keys(detectCrowdTraps({ currentOdds: 50, news: [{ date: hoursAgo(1) }], nowMs: NOW }))).toEqual(['fresh_news']);
  });

  it('can flag several traps at once in a stable order', () => {
    const t = detectCrowdTraps({ currentOdds: 12, stats: { liquidity: 500, change1d: 0 }, news: [{ date: hoursAgo(1) }], nowMs: NOW });
    expect(keys(t)).toEqual(['longshot', 'thin_market', 'fresh_news']);
  });
});
