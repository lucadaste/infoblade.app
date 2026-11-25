import { describe, it, expect } from 'vitest';
import {
  detectEvents, eventsOnLastBar, forwardReturnPct, buildEventRows,
  benjaminiHochberg, matchValidatedPatterns, cleanSeries, rsi14At,
} from './patterns.js';

// Deterministic random walk so tests don't flake.
function walk(n, seed = 7) {
  let s = seed, p = 100;
  const closes = [], volumes = [];
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const r = (s / 2147483647 - 0.5) * 0.08;   // up to +-4% a day
    p *= 1 + r;
    closes.push(p);
    volumes.push(1e6 * (1 + ((s >> 8) % 5)));
  }
  return { closes, volumes };
}

describe('detectEvents', () => {
  it('flags a 6% up day and a 4% down day', () => {
    const closes = Array(30).fill(100);
    closes.push(106);        // i=30: +6%
    closes.push(101.76);     // i=31: -4%
    const ev = detectEvents(closes, null);
    expect(ev[30]).toContain('up_5plus');
    expect(ev[31]).toContain('down_3_5');
    expect(ev[29]).toEqual([]);
  });

  it('does not re-fire the same event within the refractory window', () => {
    const closes = Array(30).fill(100);
    closes.push(106, 106, 112.36);   // +6% at 30, +6% again at 32
    const ev = detectEvents(closes, null);
    expect(ev[30]).toContain('up_5plus');
    expect(ev[32]).not.toContain('up_5plus');
  });

  it('flags a volume spike only at 2x the 20-day average', () => {
    const closes = Array(25).fill(100);
    const volumes = Array(25).fill(1000);
    volumes[22] = 1900; volumes[24] = 2500;
    const ev = detectEvents(closes, volumes);
    expect(ev[22]).not.toContain('volume_2x');
    expect(ev[24]).toContain('volume_2x');
  });

  it('fires a 3-day streak once, not on day 4', () => {
    const closes = [...Array(10).fill(100), 101, 102, 103, 104];
    const ev = detectEvents(closes, null);
    expect(ev[12]).toContain('streak_up_3');
    expect(ev[13]).not.toContain('streak_up_3');
  });

  it('uses a 365-bar year for crypto 52-week highs', () => {
    const closes = [200, ...Array(299).fill(100), 150];  // old high 300 bars back
    expect(detectEvents(closes, null, { assetClass: 'stock' }).at(-1)).toContain('high_52w');
    expect(detectEvents(closes, null, { assetClass: 'crypto' }).at(-1)).not.toContain('high_52w');
  });

  it('never looks ahead: events at day t are the same with or without later bars', () => {
    const { closes, volumes } = walk(700);
    const full = detectEvents(closes, volumes);
    for (const t of [30, 260, 400, 555, 699]) {
      const truncated = detectEvents(closes.slice(0, t + 1), volumes.slice(0, t + 1));
      expect(truncated[t]).toEqual(full[t]);
    }
    expect(eventsOnLastBar(closes.slice(0, 401), volumes.slice(0, 401))).toEqual(full[400]);
  });
});

describe('rsi14At', () => {
  it('is 100 with no down days and null without enough history', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi14At(up, 19)).toBe(100);
    expect(rsi14At(up, 10)).toBeNull();
  });
});

describe('forward returns and event rows', () => {
  it('measures forward return from the close of day i', () => {
    expect(forwardReturnPct([100, 110, 121], 0, 2)).toBeCloseTo(21);
    expect(forwardReturnPct([100, 110], 0, 5)).toBeNull();
  });

  it('subtracts the benchmark over the same dates', () => {
    const dates = Array.from({ length: 40 }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')}`);
    const closes = [...Array(30).fill(100), 106, 106, 106, 106, 106, 106, 106, 106, 106, 106];
    const bench = new Map(dates.map((d, i) => [d, i <= 30 ? 100 : 102]));
    const { events, base } = buildEventRows({ dates, closes, volumes: null }, bench);
    const ev = events.find(r => r.d === dates[30]);
    expect(ev.e).toContain('up_5plus');
    expect(ev.a[1]).toBeCloseTo(-2);     // stock flat, benchmark +2%
    expect(base['2020|1'].n).toBe(39);
  });

  it('keeps dates aligned when Yahoo returns a null close', () => {
    const s = cleanSeries({ timestamps: [0, 86400, 172800], closes: [1, null, 3], volumes: [5, 6, 7] });
    expect(s.dates).toEqual(['1970-01-01', '1970-01-03']);
    expect(s.volumes).toEqual([5, 7]);
  });
});

describe('benjaminiHochberg', () => {
  it('matches the textbook adjustment', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.5]);
    expect(q[0]).toBeCloseTo(0.04);        // 0.01 * 4/1
    expect(q[1]).toBeCloseTo(0.0533, 3);   // 0.04 * 4/3
    expect(q[2]).toBeCloseTo(0.0533, 3);   // min(0.03 * 4/2, next) = 0.0533
    expect(q[3]).toBeCloseTo(0.5);
  });
});

describe('matchValidatedPatterns', () => {
  it('only returns validated entries for the right asset class and event', () => {
    const reg = [
      { event: 'down_5plus', assetClass: 'stock', status: 'validated' },
      { event: 'down_5plus', assetClass: 'stock', status: 'rejected' },
      { event: 'down_5plus', assetClass: 'crypto', status: 'validated' },
      { event: 'high_52w', assetClass: 'stock', status: 'validated' },
    ];
    expect(matchValidatedPatterns(['down_5plus'], 'stock', reg)).toEqual([reg[0]]);
  });
});
