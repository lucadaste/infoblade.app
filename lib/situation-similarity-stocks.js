/**
 * Short-horizon stock move pattern-matching — the stocks analog of
 * lib/situation-similarity.js. Reads stock_situations (precomputed
 * feature/outcome rows, built forward by api/collect-price-snapshots.js —
 * see supabase-schema.sql for why this is precomputed rather than derived
 * from raw price_snapshots at query time) and answers "in situations with a
 * similar recent move, how has price tended to move over the next 5 minutes?"
 *
 * This is presented as historical statistical context, not a trading signal
 * or recommendation — consistent with the rest of the app's "not financial
 * advice" framing (see markets.html's Polymarket disclaimer).
 */

// Same minimum-sample-size convention as lib/situation-similarity.js and the
// source-reputation gating in api/market-analyze.js.
const MIN_SAMPLE_SIZE = 10;

const LOOKBACK_MINUTES = 30;

export function timeOfDayBucket(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const minutesSinceOpen = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10) - (9 * 60 + 30);
  if (minutesSinceOpen < 30) return 'open';
  if (minutesSinceOpen > 360) return 'close'; // last ~30min before 4pm close
  return 'midday';
}

/**
 * Derives the current situation's features for one ticker from its most
 * recent raw snapshots (a small, cheap per-ticker lookback — not the
 * expensive path). Returns null if there isn't enough recent history yet
 * (expected for the first ~30 minutes after the collector starts, or outside
 * market hours when no fresh snapshots are landing).
 */
export async function computeCurrentFeatures(supabase, ticker) {
  if (!supabase || !ticker) return null;
  try {
    const { data, error } = await supabase
      .from('price_snapshots')
      .select('ts, price, volume')
      .eq('ticker', ticker)
      .order('ts', { ascending: false })
      .limit(LOOKBACK_MINUTES + 5);
    if (error || !data || data.length < 3) return null;

    const latest = data[0];
    const fiveMinAgo = data.find(r => (new Date(latest.ts) - new Date(r.ts)) / 60000 >= 5) || data[data.length - 1];
    const fifteenMinAgo = data.find(r => (new Date(latest.ts) - new Date(r.ts)) / 60000 >= 15) || data[data.length - 1];

    const pctChange5m = fiveMinAgo.price ? (latest.price - fiveMinAgo.price) / fiveMinAgo.price * 100 : null;
    const pctChange15m = fifteenMinAgo.price ? (latest.price - fifteenMinAgo.price) / fifteenMinAgo.price * 100 : null;

    const volumes = data.map(r => r.volume).filter(v => v != null);
    const relativeVolume = volumes.length >= 3
      ? volumes[0] / (volumes.slice(1).reduce((a, b) => a + b, 0) / (volumes.length - 1) || 1)
      : null;

    return {
      ticker,
      price: latest.price,
      pctChange5m: pctChange5m != null ? Math.round(pctChange5m * 100) / 100 : null,
      pctChange15m: pctChange15m != null ? Math.round(pctChange15m * 100) / 100 : null,
      relativeVolume,
      timeOfDayBucket: timeOfDayBucket(new Date(latest.ts)),
      asOf: latest.ts,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Pools across the whole tracked universe (not just this ticker — a single
 * name won't have enough forward-collected history to be useful for weeks)
 * to find past situations with a similar 5-minute move and time-of-day, and
 * reports how price actually moved over the following 5 minutes in those
 * situations. A simple indexed range query against precomputed rows — see
 * stock_situations in supabase-schema.sql.
 */
export async function findSimilarMoves(supabase, { pctChange5m, timeOfDayBucketVal, tolerance = 1.5 } = {}) {
  if (!supabase || pctChange5m == null) return null;

  try {
    let query = supabase
      .from('stock_situations')
      .select('outcome_next_5m')
      .not('outcome_next_5m', 'is', null)
      .gte('pct_change_5m', pctChange5m - tolerance)
      .lte('pct_change_5m', pctChange5m + tolerance)
      .limit(2000);

    if (timeOfDayBucketVal) query = query.eq('time_of_day_bucket', timeOfDayBucketVal);

    const { data, error } = await query;
    if (error || !data || data.length < MIN_SAMPLE_SIZE) return null;

    const outcomes = data.map(r => r.outcome_next_5m);
    const avgMoveNext5m = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
    const pctPositive = Math.round(outcomes.filter(o => o > 0).length / outcomes.length * 100);

    return {
      sampleSize: outcomes.length,
      avgMoveNext5m: Math.round(avgMoveNext5m * 100) / 100,
      pctPositive,
    };
  } catch (_) {
    return null;
  }
}
