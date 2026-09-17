/**
 * Shared ingestion logic for game_situations — turning one ESPN game summary
 * into downsampled (score diff, period, seconds remaining) -> outcome rows.
 * Used by both scripts/backfill-game-situations.js (historical sweep) and
 * api/ingest-completed-games.js (daily cron, appends yesterday's completed
 * games) so the row-building logic exists in exactly one place.
 */
import { LEAGUE_META } from './sports-teams.js';
import { parseClockToSeconds } from './espn-live.js';

async function espnGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// NFL nests plays under drives.previous[].plays[]; NBA has a flat plays[] array.
// Both share the same per-play shape ({id, homeScore, awayScore, period.number,
// clock.displayValue}) and both id spaces match winprobability[].playId 1:1 —
// confirmed directly against live summaries for both leagues.
function extractPlays(summary) {
  if (Array.isArray(summary.plays) && summary.plays.length) return summary.plays;
  const drives = summary.drives?.previous || [];
  return drives.flatMap(d => d.plays || []);
}

/** Completed game ids for one league on one date (YYYYMMDD). Used by the daily ingest cron. */
export async function collectCompletedGameIdsForDate(league, dateParam) {
  const meta = LEAGUE_META[league];
  const data = await espnGet(`${meta.sport}/${meta.leagueSlug}/scoreboard?dates=${dateParam}`);
  return (data?.events || [])
    .filter(e => e.competitions?.[0]?.status?.type?.completed)
    .map(e => e.id);
}

/**
 * Completed game ids for one NFL season (regular season + postseason), by
 * walking the season's date range day by day.
 *
 * NOTE: the site API's scoreboard?seasontype=&week=&year= params are silently
 * IGNORED for past seasons — confirmed live: year=2024/2025 with week=1
 * returns the current (2026) season's week 1 games, not the requested year's.
 * Only the dates=YYYYMMDD form actually reaches historical data, so this walks
 * dates like collectNBAGameIds rather than using the (broken) week schedule.
 */
export async function collectNFLGameIds(year, { onProgress } = {}) {
  // "year" = season start year (e.g. 2024 season: Sep 2024 - Feb 2025 playoffs).
  const start = new Date(Date.UTC(year, 8, 1));      // Sep 1
  const end = new Date(Date.UTC(year + 1, 1, 15));    // Feb 15 (covers Super Bowl)
  const ids = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateParam = d.toISOString().slice(0, 10).replace(/-/g, '');
    const data = await espnGet(`football/nfl/scoreboard?dates=${dateParam}`);
    for (const event of data?.events || []) {
      if (event.competitions?.[0]?.status?.type?.completed) ids.push(event.id);
    }
    if (onProgress) await onProgress();
  }
  return ids;
}

/** Completed game ids for one NBA season by walking its date range day by day. */
export async function collectNBAGameIds(year, { onProgress } = {}) {
  // NBA season for "year" Y runs roughly Oct (Y-1) through June (Y) in ESPN's
  // own year labeling (e.g. year=2026 covers Oct 2025 - Jun 2026).
  const start = new Date(Date.UTC(year - 1, 9, 1));
  const end = new Date(Date.UTC(year, 5, 30));
  const ids = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateParam = d.toISOString().slice(0, 10).replace(/-/g, '');
    const data = await espnGet(`basketball/nba/scoreboard?dates=${dateParam}`);
    for (const event of data?.events || []) {
      if (event.competitions?.[0]?.status?.type?.completed) ids.push(event.id);
    }
    if (onProgress) await onProgress();
  }
  return ids;
}

/** Fetches one game's summary and turns it into downsampled game_situations rows, or [] if unavailable/incomplete. */
export async function buildSituationRows(league, gameId) {
  const meta = LEAGUE_META[league];
  if (!meta) return [];
  const summary = await espnGet(`${meta.sport}/${meta.leagueSlug}/summary?event=${gameId}`);
  if (!summary) return [];

  const comp = summary.header?.competitions?.[0];
  const competitors = comp?.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away || home.winner == null) return []; // incomplete data, skip

  const homeWon = !!home.winner;
  const finalHomeScore = parseInt(home.score, 10);
  const finalAwayScore = parseInt(away.score, 10);
  const isPlayoff = summary.header?.season?.type === 3;
  const season = summary.header?.season?.year ?? null;

  const plays = extractPlays(summary);
  const wpByPlayId = new Set((summary.winprobability || []).map(wp => wp.playId));

  // Downsample to ~one row per minute-in-period (period, floor(secondsRemaining/60))
  // so a ~190-play NFL game or ~460-play NBA game becomes a few dozen rows instead
  // of hundreds, while still keeping enough density for the tolerance-band query
  // in lib/situation-similarity.js.
  const rows = [];
  let lastBucketKey = null;
  for (const play of plays) {
    if (!wpByPlayId.has(play.id)) continue;
    const period = play.period?.number;
    const secondsRemaining = parseClockToSeconds(play.clock?.displayValue);
    if (period == null || secondsRemaining == null) continue;

    const bucketKey = `${period}:${Math.floor(secondsRemaining / 60)}`;
    if (bucketKey === lastBucketKey) continue;
    lastBucketKey = bucketKey;

    const homeScore = play.homeScore;
    const awayScore = play.awayScore;
    if (homeScore == null || awayScore == null) continue;

    rows.push({
      league,
      game_id: gameId,
      season,
      is_playoff: isPlayoff,
      period,
      seconds_remaining: secondsRemaining,
      home_score: homeScore,
      away_score: awayScore,
      score_diff: homeScore - awayScore,
      home_team: home.team?.displayName || null,
      away_team: away.team?.displayName || null,
      final_home_score: finalHomeScore,
      final_away_score: finalAwayScore,
      home_won: homeWon,
    });
  }
  return rows;
}

export async function gameAlreadyIngested(supabase, gameId) {
  const { data } = await supabase.from('game_situations').select('id').eq('game_id', gameId).limit(1);
  return !!data?.length;
}
