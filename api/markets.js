import { getSupabase, setCors, checkRateLimit, clientIp } from '../lib/http.js';

const SPORT_LABELS = {
  nba: 'NBA', nfl: 'NFL', mlb: 'MLB', nhl: 'NHL', mls: 'MLS',
  // Polymarket tags UFC events 'ufc', not 'mma' (confirmed live) — both map to
  // the same label so INDIVIDUAL_SPORTS.mma (lib/sports-teams.js) actually
  // gets reached instead of every UFC market silently falling through to the
  // generic fallback with no sport context at all.
  tennis: 'Tennis', golf: 'Golf', mma: 'MMA', ufc: 'MMA', boxing: 'Boxing',
  // 'CFB'/'CBB' map through to LEAGUE_META.cfb/.cbb (lib/sports-teams.js) via
  // normalizeSportTag, which is how a college-basketball market tells
  // matchTeams() to prefer CBB_TEAM_LOOKUP over the football-default
  // TEAM_LOOKUP for a school that fields both (e.g. "Duke").
  'college-football': 'CFB', 'college-basketball': 'CBB',
  soccer: 'Soccer', basketball: 'Basketball', football: 'Football', baseball: 'Baseball',
};
// Checked in this fixed order, NOT the event's own tag array order (which
// Polymarket doesn't guarantee) — so a specific tag like 'college-basketball'
// always wins over a generic co-occurring one like 'basketball', instead of
// whichever happens to appear first in that event's tags.
const SPORT_TAG_PRIORITY = [
  'college-football', 'college-basketball', 'ufc', 'mma',
  'nba', 'nfl', 'mlb', 'nhl', 'mls', 'tennis', 'golf', 'boxing',
  'soccer', 'basketball', 'football', 'baseball',
];

// Events matching any of these tags are excluded regardless of category
const ESPORTS_TAGS = new Set([
  'esports', 'e-sports', 'esport', 'gaming', 'video-games',
  'league-of-legends', 'lol', 'dota', 'dota-2', 'counter-strike', 'cs-go', 'csgo',
  'valorant', 'overwatch', 'fortnite', 'starcraft', 'rocket-league', 'apex-legends',
  'call-of-duty', 'pubg', 'hearthstone', 'world-of-warcraft',
]);

// Supernatural / prophecy / troll markets — no real news exists to analyze these,
// so the AI lean would just be noise. Polymarket doesn't tag these consistently,
// so we match on title keywords instead.
const NONSENSE_KEYWORDS = [
  'jesus christ return', 'second coming of christ', 'second coming of jesus', 'second coming',
  'rapture', 'antichrist', 'armageddon', 'judgment day', 'doomsday clock',
  'alien contact', 'aliens land', 'aliens make contact', 'extraterrestrial contact', 'ufo disclosure',
  'bigfoot', 'loch ness monster', 'nessie spotted',
  'time travel', 'simulation theory', 'we are in a simulation',
  'illuminati', 'lizard people', 'flat earth confirmed',
  'zombie apocalypse',
];

function _isNonsenseTitle(title) {
  const t = (title || '').toLowerCase();
  return NONSENSE_KEYWORDS.some(kw => t.includes(kw));
}

// Tags are intentionally exclusive — no tag appears in more than one category
const CATEGORY_TAGS = {
  sports:        ['nba', 'nfl', 'mlb', 'nhl', 'mls', 'tennis', 'golf', 'mma', 'boxing', 'soccer', 'basketball', 'football', 'baseball', 'sports'],
  politics:      ['politics', 'elections', 'government', 'congress', 'supreme-court', 'trump'],
  finance:       ['finance', 'economics', 'bitcoin', 'ethereum', 'crypto', 'business', 'markets'],
  entertainment: ['entertainment', 'movies', 'tv', 'awards', 'oscars', 'grammys', 'music', 'celebrity', 'pop-culture', 'culture'],
  tech:          ['tech', 'big-tech', 'ai', 'artificial-intelligence', 'spacex', 'ipo', 'deepseek']
};

const VALID_CATEGORIES = new Set(Object.keys(CATEGORY_TAGS));

// 'other' is NOT a browsable category (not in VALID_CATEGORIES, so the public
// GET handler below never accepts it from a user) — it's an internal-only
// bucket the baseline generator (api/generate-baseline.js) uses to reach
// Polymarket events whose tags don't match any of the 5 named categories
// above. Without it those events are invisible to the automated predictor
// even though api/market-analyze.js already has a working generic fallback
// pipeline (fetchLegacyGeneric) for exactly this case — they just never got
// discovered in the first place.

function _categoryForTags(eventTags) {
  for (const [cat, tags] of Object.entries(CATEGORY_TAGS)) {
    if (tags.some(t => eventTags.includes(t))) return cat;
  }
  return null;
}

// Browse results don't depend on category (tag filtering happens after the
// fetch), so the generator's five concurrent category calls share one fetch.
const BROWSE_TTL_MS = 60000;
const _browseCache = new Map(); // `${daysMin}:${daysCap}:${pages}` -> { ts, promise }

function _fetchBrowseEvents(daysMin, daysCap, pages) {
  const key = `${daysMin}:${daysCap}:${pages}`;
  const hit = _browseCache.get(key);
  if (hit && Date.now() - hit.ts < BROWSE_TTL_MS) return hit.promise;

  const promise = (async () => {
    const now = Date.now();
    const endDateMax = new Date(now + daysCap * 86400000).toISOString();
    const endDateMin = new Date(now + daysMin * 86400000).toISOString();
    // /events is deprecated (sunset 2026-05-01) in favor of /events/keyset — same
    // response shape, cursor-paginated. The API caps each page at 100 events.
    const base = `https://gamma-api.polymarket.com/events/keyset?active=true&closed=false&limit=100&order=volume24hr&ascending=false&end_date_min=${encodeURIComponent(endDateMin)}&end_date_max=${encodeURIComponent(endDateMax)}`;
    const events = [];
    let cursor = null;
    for (let page = 0; page < pages; page++) {
      const url = cursor ? `${base}&after_cursor=${encodeURIComponent(cursor)}` : base;
      let data;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        data = await r.json();
      } catch (err) {
        if (page === 0) throw err;
        break; // a slow deep page shouldn't discard the pages already fetched
      }
      if (Array.isArray(data.events)) events.push(...data.events);
      cursor = data.next_cursor;
      if (!cursor || !data.events?.length) break;
    }
    return events;
  })();
  promise.catch(() => _browseCache.delete(key));
  _browseCache.set(key, { ts: Date.now(), promise });
  return promise;
}

// ── Core fetch+filter pipeline ─────────────────────────────────────────────────
// Shared by the GET handler (real user browsing) and the baseline generator cron
// (api/generate-baseline.js), which calls this directly in-process to source
// candidate markets without re-implementing the nonsense/esports filtering and
// odds-band logic. `opts.isSearch`/`opts.rawQuery` are only meaningful when a
// caller is doing a text search (the HTTP handler); the generator always omits them.
// `opts.pages` (100 events each, by 24h volume) and `opts.limit` (markets kept per
// category) let the generator draw from a much deeper pool than the browse UI shows.
// `opts.labels: false` skips the Haiku labeling/legitimacy pass — the generator
// only analyzes a handful of the pool, so it runs labelMarkets on just those.
export async function fetchCategoryMarkets(category, opts = {}) {
  const { isSearch = false, rawQuery = '', daysCap = 365, daysMin = 0, pages = 1, limit = 10, labels = true } = opts;
  const targetTags = CATEGORY_TAGS[category];

  const now = new Date();

  let events;
  if (isSearch) {
    // Full-corpus text search (not volume-ranked/top-N) so any active Polymarket
    // event can be found regardless of how much volume it's trading — the
    // browse path below only ever sees the top ~100 markets by 24h volume.
    const searchUrl = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(rawQuery)}&active=true&closed=false&limit_per_type=50`;
    const searchRes = await fetch(
      searchUrl,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    const searchData = await searchRes.json();
    events = Array.isArray(searchData.events) ? searchData.events : [];
  } else {
    events = await _fetchBrowseEvents(daysMin, daysCap, pages);
  }

  const filtered = events.filter(event => {
    if (!event.active || event.closed || event.archived) return false;
    const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
    if (eventTags.some(t => ESPORTS_TAGS.has(t))) return false;
    if (_isNonsenseTitle(event.title)) return false;
    if (isSearch) return true; // relevance already handled by public-search
    if (category === 'other') return !Object.values(CATEGORY_TAGS).some(tags => tags.some(tag => eventTags.includes(tag)));
    return targetTags.some(tag => eventTags.includes(tag));
  });

  const markets = filtered.map(event => {
    const ms = event.markets || [];
    // Prefer a specific outcome (e.g. "PSG wins 2-1") over the generic "Other/Any
    // other score" catch-all bucket as the event's headline market — "Other" is
    // occasionally the single highest-volume sub-market, but it tells the user
    // nothing about the actual event. Fall back to it only if it's all there is.
    const isCatchAll = m => /\bother\b/i.test(m.groupItemTitle || m.question || '');
    const specific = ms.filter(m => !isCatchAll(m));
    const pool = specific.length > 0 ? specific : ms;
    const primary = pool.length === 1
      ? pool[0]
      : [...pool].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];

    if (!primary) return null;

    const endDate = primary.endDate || event.endDate || null;
    const daysLeft = endDate ? Math.ceil((new Date(endDate) - now) / 86400000) : null;

    if (daysLeft !== null && (daysLeft > daysCap || daysLeft < daysMin)) return null;

    let yesPrice = null;
    let outcomeName = null;
    try {
      const prices = typeof primary.outcomePrices === 'string'
        ? JSON.parse(primary.outcomePrices)
        : primary.outcomePrices;
      yesPrice = Math.round(parseFloat(prices[0]) * 100);
      const outcomes = typeof primary.outcomes === 'string'
        ? JSON.parse(primary.outcomes)
        : primary.outcomes;
      // Polymarket pairs outcomePrices[0] with outcomes[0] — for a plain Yes/No
      // market that's just "Yes" (self-explanatory next to the question), but for
      // a named-outcome market (team matchups: ["Patriots","Bills"]) it's the one
      // piece of data that actually says what the % is the odds of. Free and
      // always present, unlike the AI-generated yesLabel below, which can fail.
      if (outcomes && outcomes[0] && !/^yes$/i.test(outcomes[0])) outcomeName = String(outcomes[0]).slice(0, 60);
    } catch (_) {}

    if (yesPrice === null || isNaN(yesPrice)) return null;
    // Toss-up filter: exclude near-certain markets (already resolved or essentially
    // decided). Search bypasses this since the user has specific intent.
    // Tighter than 20-80 to avoid markets that have already effectively settled.
    if (!isSearch && (yesPrice < 15 || yesPrice > 85)) return null;
    const volume24h = Math.round(parseFloat(event.volume24hr || 0));
    const volumeTotal = Math.round(parseFloat(event.volume || 0));

    // Detect sport from Polymarket event tags — checked in our own fixed
    // priority order (SPORT_TAG_PRIORITY), not this event's tag array order.
    const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
    const sportTag  = SPORT_TAG_PRIORITY.find(t => eventTags.includes(t));
    const sport     = sportTag ? SPORT_LABELS[sportTag] : null;
    const resultCategory = isSearch ? (_categoryForTags(eventTags) || 'other') : category;

    return {
      id: event.id,
      slug: event.slug,
      title: String(event.title || '').slice(0, 300),
      question: String(primary.question || event.title || '').slice(0, 300),
      yesPrice,
      volume24h,
      volumeTotal,
      daysLeft,
      endDate,
      totalMarkets: ms.length,
      category: resultCategory,
      sport,
      outcomeName,
    };
  }).filter(Boolean)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, isSearch ? 20 : limit);

  return labels ? labelMarkets(markets) : markets;
}

// Batch AI call: generate a plain-english "what YES means" label for each market, and
// flag any market that's unfalsifiable/supernatural/joke (no real news could analyze it).
// The keyword filter in fetchCategoryMarkets catches known phrasings for free; this
// catches anything new without upkeep. Returns the markets that passed, labeled.
export async function labelMarkets(markets) {
  try {
    const anthropicKey = process.env.ANTHROPIC_KEY;
    if (anthropicKey && markets.length > 0) {
      const labelPrompt = `For each prediction market question below, do two things:
1. Write a 3-5 word plain English label describing exactly what the YES outcome means. Be specific — include the name/subject. No punctuation at the end.
2. Set "real" to true if this is a genuine real-world question that news coverage could inform (sports, politics, finance, entertainment, tech, etc.), or false if it's an unfalsifiable, supernatural, mythical, or joke/troll question (e.g. religious prophecy, Bigfoot, simulation theory, aliens) that no real news source could meaningfully analyze.

${markets.map((m, i) => `${i + 1}. "${m.question}"`).join('\n')}

Respond ONLY with a JSON array of objects in the same order, no markdown:
[{"label":"label text","real":true}, ...]`;

      const labelRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: Math.max(500, markets.length * 45), messages: [{ role: 'user', content: labelPrompt }] }),
        signal: AbortSignal.timeout(8000)
      });
      const labelData = await labelRes.json();
      const raw = labelData.content?.[0]?.text?.replace(/```json|```/g, '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        markets.forEach((m, i) => {
          if (parsed[i]?.label) m.yesLabel = String(parsed[i].label).slice(0, 60);
          if (parsed[i]?.real === false) m._nonsense = true;
        });
      }
    }
  } catch (_) { /* labels/legitimacy check are optional — cards still render without them */ }

  return markets.filter(m => !m._nonsense).map(({ _nonsense, ...m }) => m);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'markets', 30);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const isSearch = rawQuery.length > 0;

  const rawCategory = req.query.category;
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'sports';
  const daysCap = Math.min(Math.max(parseInt(req.query.maxDays) || 365, 1), 365);
  const daysMin = Math.min(Math.max(parseInt(req.query.minDays) || 0, 0), daysCap);

  try {
    const finalMarkets = await fetchCategoryMarkets(category, { isSearch, rawQuery, daysCap, daysMin });
    return res.status(200).json(
      isSearch ? { markets: finalMarkets, query: rawQuery } : { markets: finalMarkets, category }
    );
  } catch (err) {
    console.error('[markets]', err.message);
    return res.status(500).json({ error: 'Failed to load markets' });
  }
}
