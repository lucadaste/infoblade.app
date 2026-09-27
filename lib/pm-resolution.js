// Matching a saved prediction-market prediction to its Polymarket market and
// reading the finalized outcome. Used by the resolve pass in api/predictions.js.

export function normQuestion(q) {
  return String(q || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300).toLowerCase().replace(/\s+/g, ' ').trim();
}

// The market a prediction was actually made on. Multi-outcome events ("Who
// will be the next Attorney General?") carry dozens of markets, and the saved
// `topic` is that one market's question — grading used to take whichever
// market had the most volume *at grading time*, which drifts from the one
// that was predicted. No exact match on a multi-market event means we can't
// be sure, so it's left for the news-grade pass instead of guessed.
export function pickPmMarket(event, question) {
  const ms = event?.markets || [];
  if (ms.length === 1) return ms[0];
  const q = normQuestion(question);
  return ms.find(m => normQuestion(m.question) === q) || null;
}

// 'Yes' | 'No' once the market is finalized, else null. Checked per market,
// not per event: an event stays open while its individual markets resolve.
// `closed` alone only means trading halted — a closed-but-unresolved market's
// price can still be a stale/interim read, and trusting a 97%+ price on one
// caused a false grade in production — so the oracle status is required.
export function pmOutcome(market) {
  if (!market || market.umaResolutionStatus !== 'resolved') return null;
  let prices;
  try { prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices; }
  catch (_) { return null; }
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const yesPrice = parseFloat(prices[0]);
  return yesPrice >= 0.97 ? 'Yes' : yesPrice <= 0.03 ? 'No' : null;
}

const PM_STOPS = new Set([
  'will','does','the','this','that','for','with','not','its','has','from',
  'been','have','which','their','more','most','just','also','over','after',
  'when','what','who','would','could','should','these','those','they','them',
  'into','about','before','during','between','going','than','very','too',
]);

export function pmWordScore(q, title) {
  const qWords = q.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/)
    .filter(w => w.length > 2 && !PM_STOPS.has(w));
  if (!qWords.length) return { score: 0, matched: 0 };
  const tWords = new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/));
  const matched = qWords.filter(w => tWords.has(w)).length;
  return { score: matched / qWords.length, matched };
}
