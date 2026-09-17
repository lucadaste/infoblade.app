/**
 * Category-aware source fetching for prediction-market analysis.
 * Each fetcher returns Array<{ title, source, sourceType, grade, date }>.
 * Feed-list constants are copied (not imported) from api/analyze.js to keep
 * the stocks/crypto pipeline and the prediction-markets pipeline decoupled.
 */
import { LEAGUE_META, INDIVIDUAL_SPORTS, TEAM_LOOKUP } from './sports-teams.js';

// ── Shared RSS fetch/parse helpers (same pattern as api/analyze.js) ──────────
function fetchWithTimeout(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function parseRssItems(text, fallbackSource) {
  const items = [];
  for (const match of [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)]) {
    const item = match[1];
    const titleMatch  = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
    const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
    const dateMatch    = item.match(/<pubDate>(.*?)<\/pubDate>/);
    if (titleMatch) {
      const title  = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : fallbackSource;
      if (title.length > 10) items.push({ title, source, date: dateMatch?.[1] || null });
    }
  }
  return items;
}

async function fetchRssItems(url, timeoutMs, fallbackSource) {
  try {
    const r = await fetchWithTimeout(url, timeoutMs);
    return parseRssItems(await r.text(), fallbackSource);
  } catch (_) { return []; }
}

// Reddit blocks the generic spoofed 'Mozilla/5.0' User-Agent every other fetcher
// in this file uses (confirmed directly: identical requests get a 403 "whoa there,
// pardner!" bot-detection page with that UA and a clean 200 with this one) — Reddit's
// API guidelines specifically call out a descriptive, non-browser User-Agent as the
// expected format (platform:appid:version (by /u/username)), and generic browser
// spoofing is exactly what their bot detection targets. Swap the /u/ handle below
// for a real Reddit account if/when one exists for this app; the format matters
// more than the specific handle for this unauthenticated RSS/Atom access.
const REDDIT_HEADERS = { 'User-Agent': 'web:infoblade-pm-analyzer:v1.0 (by /u/infoblade)' };

// Reddit's search.rss/search.json endpoints return Atom (<feed><entry>...), not
// RSS 2.0 (<item>...) — confirmed directly against a live response. The shared
// parseRssItems() above only matches <item>, so it silently returns zero results
// against a real, non-empty Reddit feed. This is Reddit-specific because every
// other feed in this file (Google News, direct outlet RSS, ESPN) is confirmed
// genuine RSS 2.0 — not a case for a dual-format branch in the shared parser.
function parseRedditAtomItems(text) {
  const items = [];
  for (const match of [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]) {
    const entry = match[1];
    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const dateMatch = entry.match(/<published>(.*?)<\/published>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
    if (title.length > 10) items.push({ title, date: dateMatch?.[1] || null });
  }
  return items;
}

async function fetchRedditAtomItems(url, timeoutMs) {
  try {
    const r = await fetchWithTimeout(url, timeoutMs, REDDIT_HEADERS);
    return parseRedditAtomItems(await r.text());
  } catch (_) { return []; }
}

function buildSearchQuery(question) {
  return question
    .replace(/^(will|is|are|does|did|can|who|what|when|how|which)\s+/i, '')
    .replace(/\?$/, '')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ');
}

// Bump whenever the source-fetching/filtering methodology changes materially
// (new category profile, different budget allocation, different dedup logic,
// etc.) — NOT for bug fixes that just correct a mistake in the current
// methodology. Stored on every PM prediction generated via CATEGORY_SOURCE_PROFILES
// (analysis.sourcing_version) so historical rows from the old generic
// Google-News-+-Reddit pipeline stay distinguishable from ones generated under
// the new category-aware pipeline. Mirrors SCORING_VERSION in lib/scoring.js.
export const SOURCING_VERSION = 1;

// Legacy generic pipeline (single truncated-question Google News + Reddit query,
// no entity targeting, no relevance filter, no dedup) — a faithful port of what
// api/market-analyze.js's fallback branch used to inline, preserved here as the
// single source of truth so that branch and scripts/compare-token-usage.js can
// never silently drift into two different "old" behaviors. Returns raw
// {title, source} pairs, not grade/empirical-enriched — grading is caller-specific
// (api/market-analyze.js applies getSourceGrade + reputation; the measurement
// script applies getSourceGrade only), same division of responsibility every
// other fetcher in this file already follows.
export async function fetchLegacyGeneric(question) {
  const searchQuery = buildSearchQuery(question);
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
  const redditUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(searchQuery)}&sort=relevance&t=week&limit=10`;

  const [rssRes, redditItems] = await Promise.all([
    fetchWithTimeout(rssUrl, 8000),
    fetchRedditAtomItems(redditUrl, 5000),
  ]);

  const rssText = await rssRes.text();

  const items = [];
  const matches = [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const match of matches.slice(0, 15)) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
    const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
    const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : 'Unknown';
    if (title.length > 10) items.push({ title, source });
  }

  const redditPosts = redditItems.slice(0, 8).map(i => i.title);

  return { items, redditPosts, searchQuery };
}

// ── Feed-list constants (duplicated from api/analyze.js — deliberate, see header) ──
const FINANCIAL_NEWS_FEEDS = [
  { url: 'https://www.benzinga.com/feed',                          source: 'Benzinga' },
  { url: 'https://investorplace.com/feed/',                        source: 'InvestorPlace' },
  { url: 'https://www.thestreet.com/.rss/full',                    source: 'TheStreet' },
  { url: 'https://www.nasdaq.com/feed/nasdaq-original/rss.xml',    source: 'Nasdaq' },
  { url: 'https://www.zacks.com/customfeeds/zacksheadlines.rss',   source: 'Zacks' },
  { url: 'https://stockstotrade.com/feed/',                        source: 'StocksToTrade' },
  { url: 'https://www.stocktitan.net/news/rss.xml',                source: 'Stock Titan' },
  { url: 'https://finbold.com/feed/',                               source: 'Finbold' },
  { url: 'https://finance.yahoo.com/rss/topfinstories',             source: 'Yahoo Finance' },
];

const TECH_FEEDS = [
  { url: 'https://techcrunch.com/feed/',                            source: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/index.xml',                  source: 'The Verge' },
  { url: 'https://www.wired.com/feed/rss',                          source: 'Wired' },
  { url: 'https://venturebeat.com/feed/',                            source: 'VentureBeat' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index',         source: 'Ars Technica' },
  { url: 'https://www.technologyreview.com/feed/',                  source: 'MIT Technology Review' },
  { url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html',   source: 'CNBC' },
  { url: 'https://feeds.apnews.com/rss/apf-Technology',             source: 'AP News' },
];

const POLITICAL_FEEDS = [
  { url: 'https://feeds.reuters.com/Reuters/PoliticsNews',          source: 'Reuters' },
  { url: 'https://www.politico.com/rss/politics08.xml',             source: 'Politico' },
  { url: 'https://thehill.com/rss/syndicator/19110',                source: 'The Hill' },
  { url: 'https://www.whitehouse.gov/feed/',                        source: 'White House' },
  { url: 'https://rss.cnn.com/rss/cnn_allpolitics.rss',             source: 'CNN' },
  { url: 'https://feeds.npr.org/1014/rss.xml',                      source: 'NPR' },
  { url: 'https://feeds.apnews.com/rss/apf-politics',               source: 'AP News' },
];

// New — not previously used anywhere in this codebase, verify feeds are live before shipping.
const ENTERTAINMENT_FEEDS = [
  { url: 'https://variety.com/feed/',                               source: 'Variety' },
  { url: 'https://www.hollywoodreporter.com/feed/',                 source: 'Hollywood Reporter' },
  { url: 'https://deadline.com/feed/',                               source: 'Deadline' },
  { url: 'https://www.billboard.com/feed/',                         source: 'Billboard' },
  { url: 'https://people.com/feed/',                                source: 'People' },
];

// Sports-domain restriction list for fetchGoogleNewsRestricted('sports')
const SPORTS_DOMAINS = ['espn.com', 'cbssports.com', 'si.com', 'sportingnews.com', 'bleacherreport.com'];

// ── Outlet political-lean tags (politics category only — in-house Ground News alternative) ──
// Sourced from published outlet-bias-rating methodology (e.g. AllSides), hand-curated, not a live API.
const POLITICAL_LEAN = {
  'Reuters': 'Center', 'AP News': 'Center', 'The Hill': 'Center', 'NPR': 'Left',
  'Politico': 'Center', 'CNN': 'Left', 'Washington Post': 'Left', 'New York Times': 'Left',
  'MSNBC': 'Left', 'Fox News': 'Right', 'Breitbart': 'Right', 'New York Post': 'Right',
  'Wall Street Journal': 'Right', 'White House': 'Center',
};

function leanForSource(source) {
  const norm = (source || '').toLowerCase();
  for (const key of Object.keys(POLITICAL_LEAN)) {
    if (norm.includes(key.toLowerCase())) return POLITICAL_LEAN[key];
  }
  return null;
}

/** Politics-only: flags when included coverage skews entirely to one side. Returns a note string or null. */
export function politicalLeanNote(items) {
  const leans = items.map(i => leanForSource(i.source)).filter(Boolean);
  if (leans.length < 3) return null;
  const counts = { Left: 0, Center: 0, Right: 0 };
  for (const l of leans) counts[l]++;
  const sidesPresent = Object.values(counts).filter(c => c > 0).length;
  if (sidesPresent > 1) return null;
  const onlySide = Object.keys(counts).find(k => counts[k] > 0);
  return `Note: available coverage for this question skews entirely ${onlySide} (${leans.length}/${leans.length} sources) — treat directional confidence cautiously, this may not reflect the full picture.`;
}

// ── Entity extraction ─────────────────────────────────────────────────────────
const PROPER_NOUN_RE = /\b([A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*){0,2})\b/g;
const ENTITY_STOPLIST = new Set([
  'Super Bowl', 'World Series', 'Stanley Cup', 'NBA Finals', 'Game 7', 'Champions League',
  'Will', 'Is', 'Are', 'Does', 'Did', 'Can', 'Who', 'What', 'When', 'How', 'Which', 'The',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Yes', 'No', 'By', 'In', 'On', 'At', 'This', 'Next', 'Before', 'After',
]);

export function extractProperNouns(text) {
  const matches = [...text.matchAll(PROPER_NOUN_RE)].map(m => m[1].trim());
  const seen = new Set();
  const out = [];
  for (let m of matches) {
    // Drop leading stopword tokens (e.g. "Will Apple" -> "Apple") rather than discarding the whole run.
    const words = m.split(/\s+/);
    while (words.length && ENTITY_STOPLIST.has(words[0])) words.shift();
    m = words.join(' ');
    if (!m || ENTITY_STOPLIST.has(m) || m.length < 3) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out.slice(0, 3);
}

/** Longest-alias-first, word-boundary match against TEAM_LOOKUP. Returns up to 2 distinct teams. */
function matchTeams(question) {
  const lower = question.toLowerCase();
  const aliases = Object.keys(TEAM_LOOKUP).sort((a, b) => b.length - a.length);
  const found = [];
  const usedLeagues = new Set();
  for (const alias of aliases) {
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) {
      const entry = TEAM_LOOKUP[alias];
      if (found.some(f => f.full === entry.full)) continue;
      found.push({ alias, ...entry });
      usedLeagues.add(entry.league);
      if (found.length >= 2) break;
    }
  }
  return found;
}

function normalizeSportTag(sportField) {
  if (!sportField) return null;
  const s = sportField.toLowerCase();
  if (LEAGUE_META[s]) return s;
  // generic tags (Soccer/Basketball/Football/Baseball) don't map to a specific league on their own
  return null;
}

export function buildSportsQuery(question, sportField) {
  const teams = matchTeams(question);
  const forwardedLeague = normalizeSportTag(sportField);
  const league = teams[0]?.league || forwardedLeague || null;
  const players = extractProperNouns(question).filter(p =>
    !teams.some(t => t.full.toLowerCase().includes(p.toLowerCase()))
  );
  const sport = league ? LEAGUE_META[league]?.sport : (sportField ? sportField.toLowerCase() : null);
  return { teams, players, league, sport: sport || null, rawQuery: buildSearchQuery(question) };
}

const TICKER_RE = /\$?\b[A-Z]{1,5}\b/g;
const TICKER_STOPLIST = new Set(['A', 'I', 'THE', 'CEO', 'CFO', 'IPO', 'SEC', 'FDA', 'GDP', 'US', 'UK', 'AI', 'IT', 'OK', 'NO']);
function extractTicker(text) {
  const matches = [...text.matchAll(TICKER_RE)].map(m => m[0].replace('$', ''));
  return matches.find(t => !TICKER_STOPLIST.has(t)) || null;
}

const BILL_RE = /\b([HS]\.?\s?R\.?\s?\d+)\b/i;
function extractBillNumber(text) {
  const m = text.match(BILL_RE);
  return m ? m[1].replace(/\s+/g, '').toUpperCase() : null;
}

export function buildGenericEntityQuery(question, kind) {
  const entities = extractProperNouns(question);
  const out = { entities, rawQuery: buildSearchQuery(question) };
  if (kind === 'finance') out.ticker = extractTicker(question);
  if (kind === 'politics') out.billNumber = extractBillNumber(question);
  return out;
}

// ── Relevance post-filter ─────────────────────────────────────────────────────
export function filterRelevant(items, keywords) {
  if (!keywords || keywords.length === 0) return items;
  const lowerKw = keywords.map(k => k.toLowerCase());
  return items.filter(i => lowerKw.some(k => i.title.toLowerCase().includes(k)));
}

// ── Budget allocation: structured (5) / news (12) / reddit (6), ~23 total ────
// Same normalized-title dedup key api/analyze.js already uses for stocks/crypto —
// querying 4-5 sources at once (Google News, GDELT, NewsAPI, direct feeds, Reddit)
// means the same wire story (AP/Reuters syndication is common) easily shows up more
// than once. Only news/reddit are deduped — structured items (filings, trades, roster
// injuries) are distinctly formatted and genuinely non-duplicate even when similar
// (e.g. two different congressional trades in the same ticker are two real events).
function _dedupeKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(w => w.length > 2).slice(0, 8).join(' ');
}

// coverageVolume = how many raw items (across all fetchers, before this dedup
// pass) shared a story's dedupe key — the "duplicate/near-duplicate" count we'd
// otherwise just discard. A story covered by 1 source is a single outlet's take;
// a story covered by 5+ is either confirmed/consensus news or a saturated
// narrative the market has likely already priced in — which one is exactly what
// the reward loop is for (see coverageVolumeAccuracy in lib/context-graph.js),
// not something to assume a direction on upfront.
export function dedupeItems(items) {
  const structured = items.filter(i => i.class === 'structured');
  const rest = items.filter(i => i.class !== 'structured');
  const counts = new Map(); // dedupe key -> raw count seen
  const best = new Map();   // dedupe key -> best-graded item seen so far
  for (const item of rest) {
    const key = _dedupeKey(item.title);
    counts.set(key, (counts.get(key) || 0) + 1);
    const existing = best.get(key);
    if (!existing || gradeRank(item.grade) > gradeRank(existing.grade)) best.set(key, item);
  }
  const deduped = [...best.entries()].map(([key, item]) => ({ ...item, coverageVolume: counts.get(key) }));
  return [...structured, ...deduped];
}

export function volumeBucket(n) {
  if (n == null) return null;
  if (n >= 4) return 'high';
  if (n >= 2) return 'medium';
  return 'low';
}

export function allocateBudget(items) {
  const deduped = dedupeItems(items);
  const structured = deduped.filter(i => i.class === 'structured').slice(0, 5);
  const news = deduped.filter(i => i.class === 'news')
    .sort((a, b) => (gradeRank(b.grade) - gradeRank(a.grade)) || dateRank(b.date, a.date))
    .slice(0, 12);
  const reddit = deduped.filter(i => i.class === 'reddit')
    .sort((a, b) => dateRank(b.date, a.date))
    .slice(0, 6);
  return [...structured, ...news, ...reddit];
}
function gradeRank(g) { return { High: 3, Medium: 2, Low: 1 }[g] || 0; }
function dateRank(a, b) {
  const da = a ? new Date(a).getTime() : 0;
  const db = b ? new Date(b).getTime() : 0;
  return (isNaN(da) ? 0 : da) - (isNaN(db) ? 0 : db);
}

// ── ESPN unofficial API (sports) ──────────────────────────────────────────────
async function espnGet(path) {
  try {
    const r = await fetchWithTimeout(`https://site.api.espn.com/apis/site/v2/sports/${path}`, 6000);
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

export async function fetchESPNScoreboardNews(question, entities) {
  const items = [];
  const { teams, league, sport } = entities;
  const meta = league ? LEAGUE_META[league] : null;
  if (meta) {
    const news = await espnGet(`${meta.sport}/${meta.leagueSlug}/news?limit=20`);
    const articles = news?.articles || [];
    for (const a of articles) {
      const headline = a.headline || a.description;
      if (!headline) continue;
      if (teams.length && !teams.some(t => headline.toLowerCase().includes(t.full.toLowerCase().split(' ').pop().toLowerCase()))) continue;
      items.push({ title: headline, source: 'ESPN', sourceType: 'beat_reporter_news', class: 'news', grade: 'High', date: a.published || null });
    }
  } else if (sport && INDIVIDUAL_SPORTS[sport]) {
    const cfg = INDIVIDUAL_SPORTS[sport];
    if (cfg.espnSlug) {
      const news = await espnGet(`${cfg.espnSport}/${cfg.espnSlug}/news?limit=20`);
      for (const a of (news?.articles || [])) {
        if (!a.headline) continue;
        items.push({ title: a.headline, source: 'ESPN', sourceType: 'beat_reporter_news', class: 'news', grade: 'High', date: a.published || null });
      }
    }
  }
  return items.slice(0, 8);
}

export async function fetchESPNRoster(question, entities) {
  const { teams, league } = entities;
  const meta = league ? LEAGUE_META[league] : null;
  if (!meta || !teams.length) return [];
  const items = [];
  for (const t of teams.slice(0, 2)) {
    const data = await espnGet(`${meta.sport}/${meta.leagueSlug}/teams/${t.espnAbbr.toLowerCase()}/roster`);
    const raw = data?.athletes || [];
    // Some leagues (NBA/MLB) return a flat athlete list; others (NFL) group by position as {position, items}.
    const athletes = raw.length && raw[0]?.items ? raw.flatMap(g => g.items || []) : raw;
    for (const a of athletes) {
      if (a.injuries?.length) {
        items.push({
          title: `${a.displayName} (${t.full}): ${a.injuries[0]?.status || 'injury listed'}`,
          source: 'ESPN', sourceType: 'lineup_data', class: 'structured', grade: 'High', date: null,
        });
      }
    }
  }
  return items.slice(0, 5);
}

// ── Generic fetchers usable across categories ─────────────────────────────────
export function fetchDirectFeeds(feedList) {
  return async function (question, entities) {
    const results = await Promise.allSettled(feedList.map(f => fetchRssItems(f.url, 5000, f.source)));
    const items = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const item of r.value) items.push({ ...item, sourceType: 'general_news', class: 'news' });
      }
    }
    return items;
  };
}

export function fetchGoogleNewsRestricted(domains) {
  return async function (question, entities) {
    const query = entities.rawQuery || buildSearchQuery(question);
    const siteFilter = domains?.length ? ` (${domains.map(d => `site:${d}`).join(' OR ')})` : '';
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + siteFilter)}&hl=en-US&gl=US&ceid=US:en`;
    const items = await fetchRssItems(url, 8000, 'Unknown');
    return items.map(i => ({ ...i, sourceType: 'general_news', class: 'news' }));
  };
}

export function fetchRedditForCategory(subreddits) {
  return async function (question, entities) {
    const query = entities.rawQuery || buildSearchQuery(question);
    const results = await Promise.allSettled(subreddits.map(sub => {
      const url = `https://www.reddit.com/r/${sub}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&t=week&limit=10`;
      return fetchRedditAtomItems(url, 5000);
    }));
    const items = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        for (const item of r.value) items.push({ ...item, source: `Reddit r/${subreddits[i]}`, sourceType: 'reddit_sentiment', class: 'reddit', grade: 'Low' });
      }
    }
    return items;
  };
}

export async function fetchGDELT(question, entities) {
  const query = entities.rawQuery || buildSearchQuery(question);
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=15&timespan=1week&sort=DateDesc&sourcelang=english`;
    const r = await fetchWithTimeout(url, 8000);
    const d = await r.json();
    return (d.articles || [])
      .filter(a => a.title && a.title.length > 10)
      .map(a => ({ title: a.title, source: a.domain || 'Web', sourceType: 'general_news', class: 'news', grade: 'Medium', date: null }));
  } catch (_) { return []; }
}

export async function fetchNewsAPI(question, entities) {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) return [];
  const query = entities.rawQuery || buildSearchQuery(question);
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=15&apiKey=${apiKey}`;
    const r = await fetchWithTimeout(url, 8000);
    const d = await r.json();
    if (d.status !== 'ok') return [];
    return (d.articles || [])
      .filter(a => a.title && a.title !== '[Removed]')
      .map(a => ({ title: a.title, source: a.source?.name || 'NewsAPI', sourceType: 'general_news', class: 'news', grade: 'Medium', date: a.publishedAt || null }));
  } catch (_) { return []; }
}

export async function fetchTavily(question, entities) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const query = entities.rawQuery || buildSearchQuery(question);
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, topic: 'news', search_depth: 'basic', max_results: 7, days: 7 }),
      signal: AbortSignal.timeout(9000),
    });
    const d = await r.json();
    return (d.results || [])
      .filter(item => item.title && item.title.length > 10)
      .map(item => {
        let source = 'Web';
        try { source = new URL(item.url).hostname.replace(/^www\./, ''); } catch (_) {}
        return { title: item.title, source, sourceType: 'general_news', class: 'news', grade: 'Medium', date: item.published_date || null };
      });
  } catch (_) { return []; }
}

// Composite: GDELT always, NewsAPI/Tavily only if their env keys are configured.
export async function fetchThirdPartyNews(question, entities) {
  const fetchers = [fetchGDELT];
  if (process.env.NEWSAPI_KEY) fetchers.push(fetchNewsAPI);
  if (process.env.TAVILY_API_KEY) fetchers.push(fetchTavily);
  const results = await Promise.allSettled(fetchers.map(f => f(question, entities)));
  const items = [];
  for (const r of results) if (r.status === 'fulfilled') items.push(...r.value);
  return items;
}

// ── Government/financial data (finance + politics, shared) ───────────────────
export async function fetchCongressBills(question, entities) {
  const apiKey = process.env.CONGRESS_API_KEY;
  const billNumber = entities.billNumber;
  if (!apiKey || !billNumber) return [];
  const m = billNumber.match(/^([HS])R(\d+)$/i);
  if (!m) return [];
  const billType = m[1].toUpperCase() === 'H' ? 'hr' : 's';
  try {
    const url = `https://api.congress.gov/v3/bill/119/${billType}/${m[2]}?api_key=${apiKey}&format=json`;
    const r = await fetchWithTimeout(url, 6000);
    const d = await r.json();
    const bill = d?.bill;
    if (!bill) return [];
    const status = bill.latestAction?.text || 'Status unknown';
    return [{
      title: `${billNumber}: "${bill.title}" — latest action: ${status}`,
      source: 'congress.gov', sourceType: 'congress_bill', class: 'structured', grade: 'High',
      date: bill.latestAction?.actionDate || null,
    }];
  } catch (_) { return []; }
}

export async function fetchSECFilings(question, entities) {
  const query = entities.ticker || entities.entities?.[0];
  if (!query) return [];
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=8-K,10-K,10-Q`;
    const r = await fetchWithTimeout(url, 6000, { 'User-Agent': 'InvestmentInformatics.AI contact@infoblade.app' });
    const d = await r.json();
    const hits = d?.hits?.hits || [];
    return hits.slice(0, 5).map(h => ({
      title: `SEC filing: ${h._source?.display_names?.[0] || query} — ${h._source?.file_type || 'filing'} (${h._source?.file_date || 'date unknown'})`,
      source: 'SEC EDGAR', sourceType: 'sec_filing', class: 'structured', grade: 'High', date: h._source?.file_date || null,
    }));
  } catch (_) { return []; }
}

// Senate Stock Watcher's own site/S3 bucket is unreliable (housestockwatcher.com's House-side
// data was unreachable — DNS failure and a 403'd S3 bucket at verification time), so this uses
// the same underlying disclosure data mirrored on GitHub, which is live and free, no key.
// Covers Senate trades only; House-side coverage can be added back if a working free mirror
// resurfaces (Quiver Quantitative's paid API is the fallback if this dataset also goes stale).
const SENATE_TRADES_URL = 'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json';

let _congressTradesCache = null;
let _congressTradesCacheAt = 0;
async function _getCongressTrades() {
  const fifteenMin = 900000;
  if (_congressTradesCache && Date.now() - _congressTradesCacheAt < fifteenMin) return _congressTradesCache;
  try {
    const r = await fetchWithTimeout(SENATE_TRADES_URL, 10000);
    const data = await r.json();
    _congressTradesCache = Array.isArray(data) ? data : [];
    _congressTradesCacheAt = Date.now();
    return _congressTradesCache;
  } catch (_) { return _congressTradesCache || []; }
}

export async function fetchCongressTrades(question, entities) {
  const ticker = entities.ticker;
  const nameEntity = entities.entities?.[0];
  if (!ticker && !nameEntity) return [];
  const trades = await _getCongressTrades();
  const matches = trades.filter(t => {
    const tickerMatch = ticker && t.ticker === ticker;
    const nameMatch = nameEntity && t.senator && t.senator.toLowerCase().includes(nameEntity.toLowerCase());
    return tickerMatch || nameMatch;
  }).sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)).slice(0, 5);
  return matches.map(t => ({
    title: `Sen. ${t.senator || 'unknown'} — ${t.type || 'traded'} ${t.ticker || t.asset_description || ''} (${t.transaction_date || 'date unknown'})`,
    source: 'Senate Stock Watcher', sourceType: 'congress_trade', class: 'structured', grade: 'Medium', date: t.transaction_date || null,
  }));
}

// ── Category source profiles ──────────────────────────────────────────────────
export const CATEGORY_SOURCE_PROFILES = {
  sports: {
    buildQuery: (question, sport) => buildSportsQuery(question, sport),
    fetchers: [
      fetchESPNScoreboardNews,
      fetchESPNRoster,
      fetchGoogleNewsRestricted(SPORTS_DOMAINS),
      fetchThirdPartyNews,
      (question, entities) => {
        const meta = entities.league ? LEAGUE_META[entities.league] : null;
        const sportCfg = !meta && entities.sport ? INDIVIDUAL_SPORTS[entities.sport] : null;
        const subs = meta ? [meta.subreddit, 'sportsbook'] : sportCfg ? [sportCfg.subreddit] : ['sportsbook'];
        return fetchRedditForCategory(subs)(question, entities);
      },
    ],
  },
  politics: {
    buildQuery: (question) => buildGenericEntityQuery(question, 'politics'),
    fetchers: [
      fetchDirectFeeds(POLITICAL_FEEDS),
      fetchGoogleNewsRestricted(null),
      fetchRedditForCategory(['politics', 'PoliticalDiscussion']),
      fetchThirdPartyNews,
      fetchCongressBills,
      fetchSECFilings,
      fetchCongressTrades,
    ],
  },
  finance: {
    buildQuery: (question) => buildGenericEntityQuery(question, 'finance'),
    fetchers: [
      fetchDirectFeeds(FINANCIAL_NEWS_FEEDS),
      fetchGoogleNewsRestricted(null),
      fetchRedditForCategory(['wallstreetbets', 'investing', 'stocks']),
      fetchThirdPartyNews,
      fetchSECFilings,
      fetchCongressTrades,
    ],
  },
  entertainment: {
    buildQuery: (question) => buildGenericEntityQuery(question, 'entertainment'),
    fetchers: [
      fetchDirectFeeds(ENTERTAINMENT_FEEDS),
      fetchGoogleNewsRestricted(null),
      fetchRedditForCategory(['entertainment', 'popculturechat']),
      fetchThirdPartyNews,
    ],
  },
  tech: {
    buildQuery: (question) => buildGenericEntityQuery(question, 'tech'),
    fetchers: [
      fetchDirectFeeds(TECH_FEEDS),
      fetchGoogleNewsRestricted(null),
      fetchRedditForCategory(['technology', 'gadgets']),
      fetchThirdPartyNews,
    ],
  },
};
