// Situations where prediction-market crowds are known to misprice, detected
// from data we already have (no extra Claude call). api/market-analyze.js
// lists the ones that apply to a market in its prompt so Claude checks those
// specific angles instead of a generic "look for an edge", and saves the
// keys on the row so scripts/fit-pm-blend.js can report whether we actually
// beat the crowd in each situation. A fourth trap, a gap between the
// headline and the market's own rules, needs judgment, so Claude flags it
// itself (rules_gap in its JSON answer).
//
//   longshot     One side is priced at LONGSHOT_MAX_PCT or less. Across
//                betting markets, longshots win less often than their price
//                implies (the favorite-longshot bias).
//   thin_market  Little money trading: the price is set by few people and
//                can sit stale after news.
//   fresh_news   News from the last FRESH_HOURS while the odds have barely
//                moved since: the price may not have caught up yet.

export const LONGSHOT_MAX_PCT = 25;
export const THIN_LIQUIDITY_USD = 10000;
export const THIN_VOLUME_24H_USD = 5000;
export const FRESH_HOURS = 6;
// "Barely moved": the YES price changed by less than this many points over
// the last day (or the last hour, when that's all we have).
export const UNMOVED_MAX_PTS = 3;

export function isFresh(dateStr, nowMs = Date.now()) {
  const t = Date.parse(dateStr || '');
  if (!Number.isFinite(t)) return false;
  const ageMs = nowMs - t;
  return ageMs >= -15 * 60000 && ageMs <= FRESH_HOURS * 3600000; // small allowance for clock skew
}

// currentOdds: YES price 0-100 (or null), stats: lib/pm-resolution.js
// pmMarketStats output (or null), news: [{ title, date }].
// Returns [{ key, text }] in a stable order; empty when nothing applies.
export function detectCrowdTraps({ currentOdds = null, stats = null, news = [], nowMs = Date.now() } = {}) {
  const traps = [];

  if (typeof currentOdds === 'number' && (currentOdds <= LONGSHOT_MAX_PCT || currentOdds >= 100 - LONGSHOT_MAX_PCT)) {
    const side = currentOdds <= LONGSHOT_MAX_PCT ? 'YES' : 'NO';
    const sidePct = side === 'YES' ? currentOdds : 100 - currentOdds;
    traps.push({
      key: 'longshot',
      text: `Longshot: the ${side} side is priced at ${sidePct}%. Bettors tend to overpay for longshots, so outcomes priced like this happen somewhat less often than the price says. Don't price ${side} as high as the market unless specific evidence supports it.`,
    });
  }

  if (stats) {
    const thinLiq = stats.liquidity != null && stats.liquidity < THIN_LIQUIDITY_USD;
    const thinVol = stats.volume24h != null && stats.volume24h < THIN_VOLUME_24H_USD;
    if (thinLiq || thinVol) {
      traps.push({
        key: 'thin_market',
        text: 'Thin market: little money is trading, so the price is set by few people and can lag the news. A gap between strong evidence and the price is more believable here than in a heavily traded market.',
      });
    }
  }

  const fresh = news.filter(n => isFresh(n.date, nowMs));
  if (fresh.length) {
    const move = stats?.change1d ?? stats?.change1h;
    const unmoved = move == null || Math.abs(move) < UNMOVED_MAX_PTS;
    if (unmoved) {
      traps.push({
        key: 'fresh_news',
        text: `Fresh news the price may not reflect yet: ${fresh.length} item${fresh.length > 1 ? 's' : ''} from the last ${FRESH_HOURS} hours (marked NEW below), and the odds have ${move == null ? 'no recorded recent movement' : `moved only ${Math.abs(move)} points in the last day`}. If that news changes the picture, the market may simply not have caught up.`,
      });
    }
  }

  return traps;
}
