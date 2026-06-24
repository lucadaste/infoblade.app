import { createClient } from '@supabase/supabase-js';

const SPORT_LABELS = {
  nba: 'NBA', nfl: 'NFL', mlb: 'MLB', nhl: 'NHL', mls: 'MLS',
  tennis: 'Tennis', golf: 'Golf', mma: 'MMA', boxing: 'Boxing',
  soccer: 'Soccer', basketball: 'Basketball', football: 'Football', baseball: 'Baseball',
};

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

function _categoryForTags(eventTags) {
  for (const [cat, tags] of Object.entries(CATEGORY_TAGS)) {
    if (tags.some(t => eventTags.includes(t))) return cat;
  }
  return null;
}

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function _checkRateLimit(supabase, ip) {
  if (!supabase) return true;
  const now = new Date();
  const windowStart = new Date(now - 60000);
  const key = `${ip}:markets`;
  try {
    const { data } = await supabase.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
    if (!data || new Date(data.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      return true;
    }
    if (data.count >= 30) return false;
    await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('key', key);
    return true;
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const supabase = _getSupabase();
  const allowed = await _checkRateLimit(supabase, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const isSearch = rawQuery.length > 0;
  const searchWords = isSearch
    ? rawQuery.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1)
    : [];

  const rawCategory = req.query.category;
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'sports';
  const daysCap = Math.min(Math.max(parseInt(req.query.maxDays) || 365, 1), 365);
  const daysMin = Math.min(Math.max(parseInt(req.query.minDays) || 0, 0), daysCap);

  const targetTags = CATEGORY_TAGS[category];

  try {
    const now = new Date();
    const endDateMax = new Date(now.getTime() + daysCap * 86400000).toISOString();
    const endDateMin = new Date(now.getTime() + daysMin * 86400000).toISOString();

    const polyUrl = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=volume24hr&ascending=false&end_date_min=${encodeURIComponent(endDateMin)}&end_date_max=${encodeURIComponent(endDateMax)}`;

    const polyRes = await fetch(
      polyUrl,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    const events = await polyRes.json();
    const filtered = (Array.isArray(events) ? events : []).filter(event => {
      if (!event.active || event.closed || event.archived) return false;
      const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
      if (eventTags.some(t => ESPORTS_TAGS.has(t))) return false;
      if (_isNonsenseTitle(event.title)) return false;
      if (isSearch) {
        const title = (event.title || '').toLowerCase();
        return searchWords.every(w => title.includes(w));
      }
      return targetTags.some(tag => eventTags.includes(tag));
    });

    const markets = filtered.map(event => {
      const ms = event.markets || [];
      const primary = ms.length === 1
        ? ms[0]
        : [...ms].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];

      if (!primary) return null;

      const endDate = primary.endDate || event.endDate || null;
      const daysLeft = endDate ? Math.ceil((new Date(endDate) - now) / 86400000) : null;

      if (daysLeft !== null && (daysLeft > daysCap || daysLeft < daysMin)) return null;

      let yesPrice = null;
      try {
        const prices = typeof primary.outcomePrices === 'string'
          ? JSON.parse(primary.outcomePrices)
          : primary.outcomePrices;
        yesPrice = Math.round(parseFloat(prices[0]) * 100);
      } catch (_) {}

      if (yesPrice === null || isNaN(yesPrice)) return null;
      // Toss-up filter: exclude near-certain markets (already resolved or essentially
      // decided). Search bypasses this since the user has specific intent.
      // Tighter than 20-80 to avoid markets that have already effectively settled.
      if (!isSearch && (yesPrice < 15 || yesPrice > 85)) return null;
      const volume24h = Math.round(parseFloat(event.volume24hr || 0));
      const volumeTotal = Math.round(parseFloat(event.volume || 0));

      // Detect sport from Polymarket event tags
      const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
      const sportTag  = eventTags.find(t => SPORT_LABELS[t]);
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
        totalMarkets: ms.length,
        category: resultCategory,
        sport,
      };
    }).filter(Boolean)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, isSearch ? 20 : 10);

    // Batch AI call: generate a plain-english "what YES means" label for each market, and
    // flag any market that's unfalsifiable/supernatural/joke (no real news could analyze it).
    // Reuses this same call rather than adding a second one — the keyword filter above
    // catches known phrasings for free; this catches anything new without upkeep.
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

    const finalMarkets = markets.filter(m => !m._nonsense).map(({ _nonsense, ...m }) => m);

    return res.status(200).json(
      isSearch ? { markets: finalMarkets, query: rawQuery } : { markets: finalMarkets, category }
    );
  } catch (err) {
    console.error('[markets]', err.message);
    return res.status(500).json({ error: 'Failed to load markets' });
  }
}
