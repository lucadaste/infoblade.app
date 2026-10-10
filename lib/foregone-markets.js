// Market shapes where the answer is obvious before any analysis: an exact
// scoreline almost never hits, and a tennis match almost always completes.
// Their sub-markets are often illiquid and quoted near a fake 50%, so the
// odds-band filter alone doesn't catch them — and the odds-weighted scoring
// would credit a "No" on them as beating the crowd.
//
// Browse/baseline never analyze these (api/markets.js). A user can still
// search for one and get an analysis, but the saved call is tagged with
// analysis.excluded_reason so it never counts toward accuracy or surfaces
// in feeds.
const FOREGONE = [
  ['exact-score',     /exact score|correct score/i],
  ['completed-match', /completed match/i],
];

export function foregoneReason(text) {
  for (const [reason, re] of FOREGONE) if (re.test(text || '')) return reason;
  return null;
}

export function isExcludedFromStats(p) {
  return !!p?.analysis?.excluded_reason;
}
