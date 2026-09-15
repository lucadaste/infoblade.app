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
export function parseTimeframeDays(str) {
  if (!str) return 30;
  const s = str.toLowerCase();
  const MAX_DAYS = 730;
  if (s.includes('hour')) {
    const h = s.match(/(\d+)/);
    return Math.max(1, Math.round((h ? +h[1] : 24) / 24));
  }
  if (s.includes('day')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*day/);
    if (range) return Math.min(Math.round((+range[1] + +range[2]) / 2), MAX_DAYS);
    const single = s.match(/(\d+)\s*day/);
    return Math.min(single ? +single[1] : 7, MAX_DAYS);
  }
  if (s.includes('week')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*week/);
    if (range) return Math.min(Math.round((+range[1] + +range[2]) / 2) * 7, MAX_DAYS);
    const single = s.match(/(\d+)\s*week/);
    return Math.min(single ? +single[1] * 7 : 14, MAX_DAYS);
  }
  if (s.includes('month')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*month/);
    if (range) return Math.min(Math.round((+range[1] + +range[2]) / 2) * 30, MAX_DAYS);
    const single = s.match(/(\d+)\s*month/);
    return Math.min(single ? +single[1] * 30 : 30, MAX_DAYS);
  }
  return 30;
}
