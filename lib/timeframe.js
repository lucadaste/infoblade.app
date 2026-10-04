// Single source of truth for turning a Claude-written timeframe string (e.g.
// "3-5 days", "2 weeks", "1 month", "12 hours") into a day count.
//
// This used to be duplicated between api/analyze.js and api/predictions.js
// with different defaults and no range/hour handling in the predictions.js
// copy. api/analyze.js locks validation_date at generation time using this
// function, so the duplicate in predictions.js only ever ran as a fallback
// for rows missing validation_date — but a fallback that can silently
// disagree with the value actually used at generation time defeats the
// point of locking the grading window at all.

const MAX_DAYS = 730;

// Each unit's number must sit immediately (whitespace only) before the unit
// word — "60 trading days" doesn't count as a day-match because "trading"
// sits in between, which is what keeps an incidental aside like "(approx. 65
// trading days)" from being mistaken for the stated horizon.
// A range averages and rounds IN THE UNIT'S OWN SCALE before converting to
// days (e.g. "1-2 weeks" -> round(1.5) = 2 weeks -> 14 days, not round(10.5)
// = 11 days) — matching how each branch always worked, so this rewrite only
// changes which unit gets picked, not the day count a given unit produces.
const UNITS = [
  { name: 'month', toDays: n => n * 30 },
  { name: 'week',  toDays: n => n * 7 },
  { name: 'day',   toDays: n => n },
  { name: 'hour',  toDays: n => Math.round(n / 24) },
];

// A real range's two numbers are joined by a short connector only ("-", an
// en/em dash, "to", or "through") — NOT an unbounded `[^\d]+` gap. The looser
// version let two numbers from entirely unrelated clauses get paired as a
// fake range (e.g. "within 48 hours through 1 month" wrongly read the 48 and
// the 1 as a "48 to 1 months" range — avg 24.5 rounds to 25 months, 750 days,
// clamped to 2 years instead of the ~2 days this sentence actually means).
const RANGE_CONNECTOR = '\\s*(?:-|–|—|to|through)\\s*';

// Finds this unit's number (range average, or single value) wherever it
// first appears with a number directly in front of it, and returns both the
// day-equivalent and the string index it was found at — or null if this
// unit's word never appears with an adjacent number.
function _matchUnit(s, unit) {
  const range = s.match(new RegExp(`(\\d+)${RANGE_CONNECTOR}(\\d+)\\s*${unit.name}`));
  if (range) return { index: range.index, days: unit.toDays(Math.round((+range[1] + +range[2]) / 2)) };
  const single = s.match(new RegExp(`(\\d+)\\s*${unit.name}`));
  if (single) return { index: single.index, days: unit.toDays(+single[1]) };
  return null;
}

export function parseTimeframeDays(str) {
  if (!str) return 30;
  const s = str.toLowerCase();

  // Claude's free-text timeframe often states the real horizon once and
  // mentions a different unit later — a parenthetical trading-day conversion
  // ("Over the next 3 months (approximately 65 trading days)"), or an aside
  // about when effects peak ("60-90 days, with peak momentum in weeks
  // 6-10"). Collecting every unit's match (only when a number actually sits
  // next to it) and taking whichever occurs EARLIEST in the string — rather
  // than assuming either "biggest unit wins" or "first unit keyword found
  // wins" — tracks how these strings are actually phrased: the stated
  // horizon leads, incidental unit mentions trail it, and a bare word with
  // no adjacent number (like "weeks" in "weeks 6-10", where the number comes
  // after the word) is correctly ignored instead of forcing a wrong default.
  let best = null;
  for (const unit of UNITS) {
    const m = _matchUnit(s, unit);
    if (m && (!best || m.index < best.index)) best = m;
  }
  if (best) return Math.min(Math.max(1, Math.round(best.days)), MAX_DAYS);

  // No unit had an adjacent number anywhere (e.g. a vague "within a few
  // days") — fall back to a sensible per-unit default, coarsest unit first.
  if (s.includes('month')) return 30;
  if (s.includes('week'))  return 14;
  if (s.includes('day'))   return 7;
  if (s.includes('hour'))  return 1;
  return 30;
}
