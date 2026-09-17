// Live/pregame game context for sports prediction markets — score, period, clock,
// injuries, Vegas line, and ESPN's own win-probability projection. Scoped to
// leagues with a clean quarter/period+clock shape (NFL, NBA) per the plan;
// extending to other LEAGUE_META entries later should mostly just work since
// this only depends on the generic site.api.espn.com/summary response shape.
import { LEAGUE_META } from './sports-teams.js';
import { buildSportsQuery } from './market-source-profiles.js';

// Leagues with a verified clean quarter/period+clock shape in ESPN's summary
// response (per the plan: NFL + NBA first). Add a league here only after
// checking its summary response shares this shape closely enough.
const SUPPORTED_LEAGUES = new Set(['nfl', 'nba']);

async function espnGet(path) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

function toDateParam(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// "12:34" -> 754. Used both for live display (fetchGameContext) and by the
// historical backfill script to turn each play's clock.displayValue into
// seconds_remaining for game_situations.
export function parseClockToSeconds(displayValue) {
  if (typeof displayValue !== 'string') return null;
  const m = displayValue.match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Finds the ESPN event id for a matchup by team abbreviation, searching the
 * scoreboard for a target date (+/- 1 day, since a Polymarket market's own
 * endDate can be a little off from the actual game date) or today's board
 * when no date is known.
 */
export async function findESPNEvent(league, teamAbbrs, aroundDateISO = null) {
  const meta = LEAGUE_META[league];
  if (!meta || !teamAbbrs?.length) return null;

  const dateParams = [null];
  if (aroundDateISO) {
    const base = new Date(aroundDateISO);
    if (!isNaN(base)) {
      dateParams.length = 0;
      for (let offset = -1; offset <= 1; offset++) {
        dateParams.push(toDateParam(new Date(base.getTime() + offset * 86400000)));
      }
    }
  }

  for (const dateParam of dateParams) {
    const path = `${meta.sport}/${meta.leagueSlug}/scoreboard${dateParam ? `?dates=${dateParam}` : ''}`;
    const data = await espnGet(path);
    for (const event of data?.events || []) {
      const comp = event.competitions?.[0];
      const abbrs = (comp?.competitors || []).map(c => c.team?.abbreviation).filter(Boolean);
      if (teamAbbrs.every(a => abbrs.includes(a))) return event.id;
    }
  }
  return null;
}

/**
 * Normalized live/pregame context for one game: score, period, clock,
 * home/away, playoff flag, both teams' injuries, ESPN's own projection, and
 * the Vegas line — everything runMarketAnalysis needs to reason about a
 * sports market with real game data instead of just news headlines.
 */
export async function fetchGameContext(eventId, league) {
  const meta = LEAGUE_META[league];
  if (!meta || !eventId) return null;

  const data = await espnGet(`${meta.sport}/${meta.leagueSlug}/summary?event=${eventId}`);
  if (!data) return null;

  const comp = data.header?.competitions?.[0];
  if (!comp) return null;

  const statusType = comp.status?.type || {};
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const injuries = { home: [], away: [] };
  for (const teamInjuries of data.injuries || []) {
    const abbr = teamInjuries.team?.abbreviation;
    const side = abbr === home.team?.abbreviation ? 'home' : abbr === away.team?.abbreviation ? 'away' : null;
    if (!side) continue;
    for (const item of teamInjuries.injuries || []) {
      injuries[side].push({
        player: item.athlete?.displayName || 'Unknown',
        status: item.status || 'unknown',
      });
    }
  }

  let predictor = null;
  const rawPredictor = data.predictor;
  if (rawPredictor?.homeTeam && rawPredictor?.awayTeam) {
    predictor = {
      homeWinPct: parseFloat(rawPredictor.homeTeam.gameProjection),
      awayWinPct: parseFloat(rawPredictor.awayTeam.gameProjection),
    };
  }

  let vegasLine = null;
  const pick = data.pickcenter?.[0];
  if (pick) {
    vegasLine = {
      provider: pick.provider?.name || null,
      spread: pick.details || null,
      overUnder: pick.overUnder ?? null,
      homeMoneyLine: pick.homeTeamOdds?.moneyLine ?? null,
      awayMoneyLine: pick.awayTeamOdds?.moneyLine ?? null,
    };
  }

  return {
    state: statusType.state || 'unknown',       // 'pre' | 'in' | 'post'
    completed: !!statusType.completed,
    statusDetail: statusType.detail || statusType.shortDetail || null,
    period: comp.status?.period ?? null,
    clock: comp.status?.displayClock ?? null,
    secondsRemaining: parseClockToSeconds(comp.status?.displayClock),
    homeTeam: home.team?.displayName || null,
    awayTeam: away.team?.displayName || null,
    homeScore: home.score != null ? parseInt(home.score, 10) : null,
    awayScore: away.score != null ? parseInt(away.score, 10) : null,
    venue: data.gameInfo?.venue?.fullName || null,
    // ESPN's season.type: 1=preseason, 2=regular season, 3=postseason (confirmed
    // via live data — regular-season games return type:2, no {name} field present).
    isPlayoff: data.header?.season?.type === 3,
    injuries,
    predictor,
    vegasLine,
  };
}

/**
 * One-call convenience: resolve a market question straight to live/pregame
 * game context, or null if the league isn't supported yet, both teams in the
 * matchup couldn't be identified, or no matching ESPN event was found. Shared
 * by runMarketAnalysis (prompt context) and the lightweight live-game badge
 * endpoint so team-matching/event-lookup logic exists in exactly one place.
 */
export async function findGameContextForQuestion(question, sportField = null, daysLeft = null) {
  const entities = buildSportsQuery(question, sportField);
  if (!entities.league || !SUPPORTED_LEAGUES.has(entities.league)) return null;

  const teamAbbrs = entities.teams.map(t => t.espnAbbr).filter(Boolean);
  if (teamAbbrs.length < 2) return null; // need both sides of the matchup to find the right event

  const aroundDateISO = daysLeft != null ? new Date(Date.now() + daysLeft * 86400000).toISOString() : null;
  const eventId = await findESPNEvent(entities.league, teamAbbrs, aroundDateISO);
  if (!eventId) return null;

  const context = await fetchGameContext(eventId, entities.league);
  return context ? { ...context, eventId, league: entities.league } : null;
}
