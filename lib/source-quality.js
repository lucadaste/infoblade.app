/**
 * Single source of truth for outlet-tier grading, shared by api/analyze.js
 * (stock/crypto) and api/market-analyze.js (prediction markets), which
 * previously each hand-maintained their own separate SOURCE_QUALITY dict —
 * the two had drifted (e.g. "Yahoo Finance" was Medium in one and Unknown
 * in the other for the same outlet). Merging them here means a source gets
 * the same tier no matter which pipeline touches it.
 *
 * The static tier below is only a COLD-START PRIOR. Once a source has
 * enough tracked outcomes in source_reputation, getSourceGrade() blends that
 * static tier with the source's own empirical accuracy via Beta-Binomial
 * shrinkage (see betaShrunkAccuracy below) — a source's real track record on
 * this platform is a stronger signal than a hand-typed guess, and it
 * self-updates instead of requiring someone to keep expanding this list
 * forever.
 */
import { TIER_PRIORS } from './source-quality-priors.js';

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

/**
 * Beta-Binomial shrinkage (aka empirical Bayes credibility weighting — the
 * same math actuaries use to price an individual risk with limited claims
 * history against the wider pool's average, and the same idea behind IMDB's
 * weighted rating formula). A source's estimated true accuracy is a blend of
 * its tier's baseline prior and its own observed track record, weighted by
 * how much of each we have:
 *
 *   estimate = (alpha + correct) / (alpha + beta + attempts)
 *
 * where alpha = priorMean * priorStrength, beta = (1 - priorMean) * priorStrength.
 * `priorStrength` pseudo-observations of prior belief are mixed in alongside
 * the real `attempts` — with zero real attempts the estimate is exactly the
 * prior mean; as attempts grows past priorStrength, the estimate converges
 * toward the raw empirical rate. This replaces a hard "20 attempts unlocks a
 * full tier jump" cutoff with a smooth blend, so a source can never swing
 * wildly off a small, noisy sample, but a long, real track record eventually
 * dominates the initial guess entirely — exactly the restaurant-review
 * problem (3 reviews at 5 stars shouldn't outrank 500 reviews at 4.6).
 */
export function betaShrunkAccuracy(staticGrade, reputation) {
  const prior = TIER_PRIORS[staticGrade] || TIER_PRIORS.Unknown;
  const alpha = prior.mean * prior.strength;
  const beta  = (1 - prior.mean) * prior.strength;
  const attempts = reputation?.attempts || 0;
  const correct  = reputation?.correct  || 0;
  return (alpha + correct) / (alpha + beta + attempts);
}

// Decision boundaries for mapping the continuous shrunk estimate back to a
// discrete tier (the rest of the app — the Claude prompts, the weight table —
// consumes a tier string, not a raw probability). Set at the midpoints
// between adjacent tier means, so a source only crosses into the next tier
// once its own evidence has genuinely pulled it past the boundary between
// them, not just past its own prior.
const HIGH_MEDIUM_BOUNDARY = (TIER_PRIORS.High.mean + TIER_PRIORS.Medium.mean) / 2;
const MEDIUM_LOW_BOUNDARY  = (TIER_PRIORS.Medium.mean + TIER_PRIORS.Low.mean) / 2;

// Floating-point equality is never safe to compare directly — the same
// mathematical value can round to slightly different bit patterns depending
// on the arithmetic path that produced it (verified directly: (0.65+0.55)/2
// and an equivalent value from the shrinkage formula landed on opposite
// sides of 0.6 by less than 1e-16, which would have silently misclassified
// an exact-boundary source). A tiny epsilon absorbs that noise without
// meaningfully changing where the boundary actually sits.
const FLOAT_EPSILON = 1e-9;

function tierFromAccuracy(p) {
  if (p >= HIGH_MEDIUM_BOUNDARY - FLOAT_EPSILON) return 'High';
  if (p >= MEDIUM_LOW_BOUNDARY - FLOAT_EPSILON) return 'Medium';
  return 'Low';
}

// 'Unknown' isn't really a point on the High/Medium/Low scale the way the
// named tiers are — it means "no rating exists yet," not "assume average."
// Its prior mean (0.50) sits deliberately right at the Medium/Low boundary,
// so with no floor at all, 2 lucky outcomes for a totally unproven source
// would already read as "Medium" — barely different from the old hard-jump
// problem this whole rewrite was meant to fix. Named tiers don't need this:
// they already carry a real prior belief, so even a small nudge from real
// evidence is legitimate new information layered on top of it. An unrated
// source needs a minimum foothold of evidence before we'll say anything
// about it at all — the same reason a brand-new eBay seller or Uber driver
// shows "New" instead of a number after their first couple of transactions.
const MIN_ATTEMPTS_TO_RATE_UNKNOWN = 5;

/**
 * Adjusts a static tier using the shrunk accuracy estimate above. With zero
 * tracked attempts this is a no-op (returns the static tier unchanged) —
 * shrinkage with zero evidence is mathematically just the prior mean anyway,
 * but returning the tier directly avoids float-boundary edge cases and keeps
 * an untouched source's grade identical to before this ever ran.
 */
export function adjustGradeForReputation(staticGrade, reputation) {
  if (!reputation || !reputation.attempts) return staticGrade;
  if (staticGrade === 'Unknown' && reputation.attempts < MIN_ATTEMPTS_TO_RATE_UNKNOWN) return staticGrade;
  return tierFromAccuracy(betaShrunkAccuracy(staticGrade, reputation));
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
