/**
 * Historical "similar statline" lookup for live in-game sports analysis.
 * Queries game_situations (populated by scripts/backfill-game-situations.js and
 * kept current by api/ingest-completed-games.js) for past games with a close
 * score/time situation, and reports how often the trailing side in those
 * situations went on to win. See supabase-schema.sql for the table shape.
 */

// Same minimum-sample-size convention used elsewhere in this codebase (e.g.
// `attempts >= 10` in api/market-analyze.js's source-reputation gating) — below
// this, report "not enough data" rather than a misleadingly precise percentage.
const MIN_SAMPLE_SIZE = 10;

/**
 * @param {object} supabase - Supabase client (server-side, service role)
 * @param {object} situation
 * @param {string} situation.league - 'nfl' | 'nba'
 * @param {number} situation.period
 * @param {number} situation.scoreDiff - home_score - away_score, signed, for the CURRENT game
 * @param {number} situation.secondsRemaining - seconds remaining in the current period
 * @param {boolean|null} [situation.isPlayoff]
 * @returns {Promise<{sampleSize: number, trailingTeamWinRate: number}|null>}
 */
export async function findSimilarSituations(supabase, {
  league, period, scoreDiff, secondsRemaining, isPlayoff = null,
  periodTolerance = 1, scoreDiffTolerance = 3, secondsTolerance = 180,
} = {}) {
  if (!supabase || !league || period == null || scoreDiff == null || secondsRemaining == null) return null;
  if (scoreDiff === 0) return null; // a tied game has no "trailing team" to ask about

  try {
    let query = supabase
      .from('game_situations')
      .select('home_won, score_diff')
      .eq('league', league)
      .not('home_won', 'is', null)
      .gte('period', period - periodTolerance)
      .lte('period', period + periodTolerance)
      .gte('score_diff', scoreDiff - scoreDiffTolerance)
      .lte('score_diff', scoreDiff + scoreDiffTolerance)
      .gte('seconds_remaining', Math.max(0, secondsRemaining - secondsTolerance))
      .lte('seconds_remaining', secondsRemaining + secondsTolerance)
      .limit(500);

    if (isPlayoff != null) query = query.eq('is_playoff', isPlayoff);

    const { data, error } = await query;
    if (error || !data) return null;

    // Only rows where a side was actually trailing count toward the answer —
    // the tolerance band can include a few near-zero rows on the other side of
    // 0 at small |scoreDiff|, which don't have a well-defined "trailing team".
    const validRows = data.filter(row => row.score_diff !== 0);
    if (validRows.length < MIN_SAMPLE_SIZE) return null;

    const trailingWon = validRows.filter(row => {
      const rowTrailingSide = row.score_diff < 0 ? 'home' : 'away';
      return (rowTrailingSide === 'home' && row.home_won) || (rowTrailingSide === 'away' && !row.home_won);
    });

    return {
      sampleSize: validRows.length,
      trailingTeamWinRate: Math.round(trailingWon.length / validRows.length * 100),
    };
  } catch (_) {
    return null;
  }
}
