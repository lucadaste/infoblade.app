import { describe, it, expect } from 'vitest';
import { logit, sigmoid, brier, logLoss, fitLogistic, predictLogistic, bootstrapBrierDiff } from './pm-blend.js';

// Deterministic PRNG so the simulated markets are the same every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

// Simulated markets: the true chance is `truth`; the crowd sees it with
// noise; the model either sees independent signal or only copies the crowd.
function simulate(n, { modelIndependent }, seed = 7) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const rows = [];
  for (let i = 0; i < n; i++) {
    const z = gauss() * 1.2;
    const truth = 100 * sigmoid(z);
    const market = 100 * sigmoid(z + gauss() * 0.8);
    const model = modelIndependent ? 100 * sigmoid(z + gauss() * 0.8) : market;
    rows.push({ market, model, y: r() * 100 < truth ? 1 : 0 });
  }
  return rows;
}

describe('logit / sigmoid', () => {
  it('round-trips and clamps the extremes', () => {
    expect(100 * sigmoid(logit(70))).toBeCloseTo(70, 6);
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(100))).toBe(true);
  });
});

describe('brier / logLoss', () => {
  it('scores a coin flip at 0.25 Brier', () => {
    expect(brier([50, 50], [1, 0])).toBeCloseTo(0.25, 10);
  });
  it('is lower for better forecasts', () => {
    expect(brier([90, 10], [1, 0])).toBeLessThan(brier([60, 40], [1, 0]));
    expect(logLoss([90, 10], [1, 0])).toBeLessThan(logLoss([60, 40], [1, 0]));
  });
  it('returns null on no rows', () => {
    expect(brier([], [])).toBeNull();
  });
});

describe('fitLogistic', () => {
  it('gives a model with independent information real weight', () => {
    const rows = simulate(4000, { modelIndependent: true });
    const w = fitLogistic(rows.map(r => [logit(r.market), logit(r.model)]), rows.map(r => r.y));
    expect(w[2]).toBeGreaterThan(0.2);
    expect(w[1]).toBeGreaterThan(0.2);
  });

  it('beats the crowd alone when the model is independent', () => {
    const rows = simulate(4000, { modelIndependent: true });
    const w = fitLogistic(rows.map(r => [logit(r.market), logit(r.model)]), rows.map(r => r.y));
    const blend = rows.map(r => predictLogistic(w, [logit(r.market), logit(r.model)]));
    const ys = rows.map(r => r.y);
    expect(brier(blend, ys)).toBeLessThan(brier(rows.map(r => r.market), ys));
  });

  it('stays finite on perfectly separated data', () => {
    const w = fitLogistic([[-2], [-1], [1], [2]], [0, 0, 1, 1]);
    expect(w.every(Number.isFinite)).toBe(true);
  });
});

describe('bootstrapBrierDiff', () => {
  it('brackets zero when both forecasts are identical', () => {
    const ci = bootstrapBrierDiff([60, 40, 70], [60, 40, 70], [1, 0, 1]);
    expect(ci.lower).toBeCloseTo(0, 10);
    expect(ci.upper).toBeCloseTo(0, 10);
  });
  it('is entirely negative when the first forecast is clearly better', () => {
    const rows = simulate(2000, { modelIndependent: true }, 11);
    const ys = rows.map(r => r.y);
    const perfect = ys.map(y => (y ? 95 : 5));
    const ci = bootstrapBrierDiff(perfect, rows.map(r => r.market), ys);
    expect(ci.upper).toBeLessThan(0);
  });
});
