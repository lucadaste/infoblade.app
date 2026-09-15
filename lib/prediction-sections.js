// Maps prediction `category` values to the 3 public-facing sections (Stocks /
// Crypto / Prediction Markets). Shared between api/predictions.js (stats/resolve)
// and api/generate-baseline.js (the daily baseline generator), which needs the
// identical mapping to know which section's daily quota a candidate counts
// against — same motivation as lib/coin-symbols.js: one definition, not two
// that can silently drift apart.
export const SECTION_CATS = {
  stocks:              new Set(['any','technology','macro','energy','financials','precious-metals','real-estate','consumer','healthcare','defense','etfs','stock']),
  crypto:              new Set(['crypto-coin']),
  'prediction-markets': new Set(['prediction-markets','politics','sports','entertainment','finance','tech']),
};

export const SECTION_LABELS = { stocks: 'Stock Markets', crypto: 'Crypto', 'prediction-markets': 'Prediction Markets' };

export function categoryToSection(cat) {
  for (const [s, cats] of Object.entries(SECTION_CATS)) { if (cats.has(cat)) return s; }
  return 'stocks';
}
