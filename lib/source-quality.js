/**
 * Single source of truth for outlet-tier grading, shared by api/analyze.js
 * (stock/crypto) and api/market-analyze.js (prediction markets), which
 * previously each hand-maintained their own separate SOURCE_QUALITY dict —
 * the two had drifted (e.g. "Yahoo Finance" was Medium in one and Unknown
 * in the other for the same outlet). Merging them here means a source gets
 * the same tier no matter which pipeline touches it.
 *
 * The static tier below is only a COLD-START PRIOR. Once a source has
 * enough tracked outcomes in source_reputation, getSourceGrade() adjusts
 * the tier up or down by one notch based on its actual empirical accuracy
 * on this platform — a source's real track record here is a stronger
 * signal than a hand-typed guess, and it self-updates instead of requiring
 * someone to keep expanding this list forever.
 */

const SOURCE_QUALITY = {
  // Tier: High — wire services, major financial press, official/govt
  'Reuters': 'High', 'Associated Press': 'High', 'AP': 'High', 'Bloomberg': 'High',
  'Financial Times': 'High', 'The Wall Street Journal': 'High', 'Wall Street Journal': 'High',
  'The Economist': 'High', 'BBC': 'High', 'NPR': 'High', 'CNBC': 'High',
  'White House': 'High', 'Politico': 'High', "Barron's": 'High',
  'S&P Global': 'High', "Moody's": 'High', 'Fitch': 'High',
  'Washington Post': 'High', 'New York Times': 'High',

  // Tier: Medium — established financial & tech media
  'The Hill': 'Medium', 'Business Insider': 'Medium', 'MarketWatch': 'Medium',
  'Yahoo Finance': 'Medium', 'CNN': 'Medium', 'The Guardian': 'Medium',
  'NBC News': 'Medium', 'CBS News': 'Medium', 'ABC News': 'Medium',
  'Fox Business': 'Medium', 'Forbes': 'Medium', 'Quartz': 'Medium',
  'Axios': 'Medium', 'Bloomberg Opinion': 'Medium',

  // Financial analysis & stock news
  'Benzinga': 'Medium', 'InvestorPlace': 'Medium', 'The Motley Fool': 'Medium',
  'Motley Fool': 'Medium', 'Zacks': 'Medium', 'TheStreet': 'Medium',
  'Investopedia': 'Medium', 'Nasdaq': 'Medium', 'Barchart': 'Medium',
  'TipRanks': 'Medium', 'Seeking Alpha': 'Medium', 'Stock Analysis': 'Medium',
  'Stock Titan': 'Medium', 'StocksToTrade': 'Medium', 'Quiver Quantitative': 'Medium',
  'Traders Union': 'Medium', 'AlphaStreet': 'Medium', 'Finbold': 'Medium',
  'GuruFocus': 'Medium', '24/7 Wall St': 'Medium', 'Simply Wall St': 'Medium',
  'Proactive Investors': 'Medium', 'GlobeNewswire': 'Medium', 'PR Newswire': 'Medium',
  'Business Wire': 'Medium', 'Globe Newswire': 'Medium',

  // Tech media
  'TechCrunch': 'Medium', 'The Verge': 'Medium', 'Wired': 'Medium',
  'VentureBeat': 'Medium', 'Ars Technica': 'Medium', 'MIT Technology Review': 'Medium',
  '9to5Mac': 'Medium', 'MacRumors': 'Medium', 'AppleInsider': 'Medium',
  'Android Authority': 'Medium', 'ZDNet': 'Medium', 'CNET': 'Medium',
  "Tom's Hardware": 'Medium', 'AnandTech': 'Medium', 'PCMag': 'Medium', 'Engadget': 'Medium',

  // Crypto
  'CoinDesk': 'Medium', 'The Block': 'Medium', 'Decrypt': 'Medium',
  'Forkast': 'Medium', 'CoinPost': 'Medium', 'Cointelegraph': 'Low',

  // Sports
  'ESPN': 'High', 'The Athletic': 'High', 'CBS Sports': 'Medium',
  'Sports Illustrated': 'Medium', 'Yahoo Sports': 'Medium', 'Bleacher Report': 'Medium',
  'Sporting News': 'Medium', 'NBC Sports': 'Medium', 'Fox Sports': 'Medium',

  // Entertainment
  'Variety': 'High', 'Hollywood Reporter': 'High', 'Deadline': 'High',
  'Entertainment Weekly': 'Medium', 'People': 'Medium', 'TMZ': 'Medium',
  'E! News': 'Medium', 'Billboard': 'Medium',

  // Low-credibility
  'Fox News': 'Low', 'Breitbart': 'Low', 'ZeroHedge': 'Low', 'Daily Mail': 'Low',
  'New York Post': 'Low', 'The Daily Caller': 'Low', 'Infowars': 'Low', 'The Blaze': 'Low',
  'US Weekly': 'Low', 'In Touch': 'Low', 'National Enquirer': 'Low', 'OK Magazine': 'Low',

  // Reddit (generic catch-all — specific fetchers that set grade directly, e.g.
  // market-source-profiles.js's fetchRedditForCategory, bypass this lookup entirely)
  'Reddit': 'Low', 'Reddit r/wallstreetbets': 'Low', 'Reddit r/investing': 'Low',
  'Reddit r/stocks': 'Low', 'Reddit r/options': 'Low', 'Reddit r/StockMarket': 'Low',
  'Reddit r/CryptoCurrency': 'Low', 'Reddit r/Bitcoin': 'Low', 'Reddit r/ethereum': 'Low',
  'Reddit r/CryptoMarkets': 'Low',
};

function normalizeSourceName(source) {
  return String(source || '')
    .replace(/\s*\(.*?\)/g, '').replace(/[""'']/g, '')
    .replace(/\b(news|tv|online|magazine|channel)\b/gi, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ').trim().toLowerCase();
}

/** Static-only lookup, no reputation adjustment — used for cold-start display before any track record exists. */
export function staticSourceGrade(source) {
  const normalized = normalizeSourceName(source);
  for (const key of Object.keys(SOURCE_QUALITY)) {
    if (normalized.includes(key.toLowerCase())) return SOURCE_QUALITY[key];
  }
  return 'Unknown';
}

const TIERS = ['Low', 'Medium', 'High'];
const REPUTATION_MIN_ATTEMPTS = 20;
const PROMOTE_ACCURACY = 0.65;
const DEMOTE_ACCURACY = 0.35;

/**
 * Adjusts a static tier by one notch based on empirical accuracy, once a
 * source has enough tracked attempts to trust the sample. An Unknown-grade
 * source with a strong proven track record can earn its way to Medium (never
 * straight to High — that still requires the static prior or a Medium track
 * record moving up). Deliberately one notch at a time and gated on volume,
 * so a handful of lucky/unlucky calls can't swing a source's grade wildly.
 */
export function adjustGradeForReputation(staticGrade, reputation) {
  if (!reputation || reputation.attempts < REPUTATION_MIN_ATTEMPTS) return staticGrade;
  const accuracy = reputation.correct / reputation.attempts;
  const idx = TIERS.indexOf(staticGrade);
  if (idx === -1) return accuracy >= PROMOTE_ACCURACY ? 'Medium' : staticGrade;
  if (accuracy >= PROMOTE_ACCURACY && idx < TIERS.length - 1) return TIERS[idx + 1];
  if (accuracy <= DEMOTE_ACCURACY && idx > 0) return TIERS[idx - 1];
  return staticGrade;
}

/**
 * Full grade lookup: static outlet-tier prior, adjusted by this source's own
 * empirical accuracy on the platform when there's enough tracked history.
 * `reputation` is the map shape both pipelines already build from the
 * source_reputation table: { [sourceName]: { attempts, correct } }.
 */
export function getSourceGrade(source, reputation) {
  const staticGrade = staticSourceGrade(source);
  return adjustGradeForReputation(staticGrade, reputation?.[source]);
}
