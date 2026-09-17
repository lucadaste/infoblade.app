// Shared parser for the model's self-reported "N — reason" confidence string
// (see the confidence rubric in api/analyze.js). Previously duplicated as a
// private copy inside api/predictions.js only — pulled out so api/analyze.js
// can use the exact same parsing to gate crypto-coin "no real signal"
// predictions (see runAnalysis in api/analyze.js) without risking the two
// copies drifting the way lib/timeframe.js's predecessor did.
export function parseConfidenceStars(conf) {
  if (!conf) return 3;
  const m = String(conf).match(/^\s*([1-5])/);
  return m ? parseInt(m[1]) : 3;
}
