import { createClient } from '@supabase/supabase-js';
import { buildContextGraph, formatContextForPrompt } from '../lib/context-graph.js';
import { CATEGORY_SOURCE_PROFILES, allocateBudget, politicalLeanNote, volumeBucket, fetchLegacyGeneric, SOURCING_VERSION } from '../lib/market-source-profiles.js';
import { findGameContextForQuestion } from '../lib/espn-live.js';
import { findSimilarSituations } from '../lib/situation-similarity.js';

const SOURCE_QUALITY = {
  // Wire / Financial
  'Reuters': 'High', 'Associated Press': 'High', 'AP': 'High',
  'Bloomberg': 'High', 'Financial Times': 'High', 'Wall Street Journal': 'High',
  'BBC': 'High', 'NPR': 'High', 'CNBC': 'High',
  // Sports
  'ESPN': 'High', 'The Athletic': 'High', 'CBS Sports': 'Medium',
  'Sports Illustrated': 'Medium', 'Yahoo Sports': 'Medium',
  'Bleacher Report': 'Medium', 'Sporting News': 'Medium',
  'NBC Sports': 'Medium', 'Fox Sports': 'Medium',
  // Politics / Law
  'Politico': 'High', 'Axios': 'Medium', 'The Hill': 'Medium',
  'NBC News': 'Medium', 'CBS News': 'Medium', 'ABC News': 'Medium',
  'CNN': 'Medium', 'Washington Post': 'High', 'New York Times': 'High',
  // Entertainment
  'Variety': 'High', 'Hollywood Reporter': 'High', 'Deadline': 'High',
  'Entertainment Weekly': 'Medium', 'People': 'Medium', 'TMZ': 'Medium',
  'E! News': 'Medium', 'Billboard': 'Medium',
  // Low
  'Fox News': 'Low', 'Breitbart': 'Low', 'Daily Mail': 'Low',
  'New York Post': 'Low', 'US Weekly': 'Low', 'In Touch': 'Low',
  'National Enquirer': 'Low', 'OK Magazine': 'Low',
  // Social / Reddit
  'Reddit': 'Low'
};

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
  const key = `${ip}:market-analyze`;
  try {
    const { data } = await supabase.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
    if (!data || new Date(data.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      return true;
    }
    if (data.count >= 20) return false;
    await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('key', key);
    return true;
  } catch (_) { return false; }
}

function _sanitize(str, maxLen = 300) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, maxLen);
}

export function getSourceGrade(source) {
  const norm = source.toLowerCase();
  for (const key of Object.keys(SOURCE_QUALITY)) {
    if (norm.includes(key.toLowerCase())) return SOURCE_QUALITY[key];
  }
  return 'Unknown';
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

async function readReputation(supabase) {
  if (!supabase) return {};
  try {
    const { data: rows } = await supabase.from('source_reputation').select('*');
    const rep = {};
    for (const row of rows || []) rep[row.source] = { attempts: row.attempts, correct: row.correct };
    return rep;
  } catch (_) { return {}; }
}

const PM_CATS = new Set(['politics', 'sports', 'entertainment', 'finance', 'tech']);

// ── Source-type reward loop helpers ─────────────────────────────────────────
// Resolve Claude's cited `key_sources` (outlet names) back to the sourceType tag
// each fetcher assigned (see lib/market-source-profiles.js), same substring-match
// style as getSourceGrade. Only types Claude actually cited get stored — not
// everything fetched — so the reward loop reflects what influenced the call.
function _resolveSourceTypes(citedSources, sourceTypeMap) {
  const types = {};
  for (const cited of citedSources || []) {
    const norm = (cited || '').toLowerCase();
    for (const [source, type] of Object.entries(sourceTypeMap)) {
      if (norm.includes(source.toLowerCase()) || source.toLowerCase().includes(norm)) {
        types[type] = true;
        break;
      }
    }
  }
  return Object.keys(types).length ? types : null;
}

// Same cited-sources resolution as _resolveSourceTypes, but for coverage volume —
// takes the highest volume among cited sources as this prediction's bucket, since a
// call that leaned on even one heavily-covered story is a call shaped by that volume,
// regardless of what else was in the (mostly lower-volume) surrounding item list.
function _resolveVolumeBucket(citedSources, sourceVolumeMap) {
  let maxVolume = null;
  for (const cited of citedSources || []) {
    const norm = (cited || '').toLowerCase();
    for (const [source, volume] of Object.entries(sourceVolumeMap)) {
      if (norm.includes(source.toLowerCase()) || source.toLowerCase().includes(norm)) {
        if (maxVolume == null || volume > maxVolume) maxVolume = volume;
        break;
      }
    }
  }
  return volumeBucket(maxVolume);
}

// Contrarian = the lean went against the market's own recent odds movement, using
// our own prior snapshots of this slug as the momentum proxy (the only odds-history
// data on hand without a new API call — see plan for the CLOB price-history upgrade path).
async function _computeOddsMomentum(supabase, slug, currentOdds) {
  if (!supabase || !slug || currentOdds == null) return { direction: 'unknown', delta: null, priorOdds: null, priorRecordedAt: null };
  try {
    const { data: prior } = await supabase
      .from('predictions')
      .select('market_odds_at_time, created_at')
      .eq('market_slug', slug)
      .not('market_odds_at_time', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!prior) return { direction: 'unknown', delta: null, priorOdds: null, priorRecordedAt: null };
    const delta = currentOdds - prior.market_odds_at_time;
    const direction = delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat';
    return { direction, delta, priorOdds: prior.market_odds_at_time, priorRecordedAt: prior.created_at };
  } catch (_) { return { direction: 'unknown', delta: null, priorOdds: null, priorRecordedAt: null }; }
}
function _isContrarian(lean, direction) {
  if (direction === 'unknown') return null;
  return (lean === 'Yes' && direction === 'down') || (lean === 'No' && direction === 'up');
}

// ── Core single-market analyze-and-save pipeline ───────────────────────────────
// Shared by the POST handler (real user-triggered analysis) and the baseline
// generator cron (api/generate-baseline.js), which calls this directly in-process.
// Callers are expected to have already sanitized `question` etc. Returns either
// the success payload or { error, status } for the caller to translate to HTTP.
export async function runMarketAnalysis({
  supabase, question, currentOdds, marketCategory = '', slug = null,
  daysLeft = null, baselineGenerated = false, sport = null,
}) {
  // If market is already trading at extreme odds it's effectively resolved — skip analysis
  if (currentOdds !== undefined && (currentOdds >= 93 || currentOdds <= 7)) {
    return {
      lean: 'Uncertain',
      lean_confidence: 'Low',
      reasoning: `The market is already trading at ${currentOdds}% — the crowd has essentially decided this outcome. There is no meaningful prediction to make.`,
      key_sources: [],
      signal: 'Inconclusive',
      signal_detail: 'Market odds indicate the outcome is already near-certain.',
      articlesFound: 0,
      predictionSaved: false,
    };
  }

  // ── Response cache: same question analyzed in the last 15 minutes ──────────
  // (shorter than analyze.js's 2hr window — PM odds/news move faster)
  if (supabase) {
    try {
      const fifteenMinAgo = new Date(Date.now() - 900000).toISOString();
      const { data: cached } = await supabase
        .from('predictions')
        .select('analysis')
        .eq('topic', question)
        .gte('created_at', fifteenMinAgo)
        .not('analysis', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cached?.analysis?.lean) {
        return { ...cached.analysis, _cached: true };
      }
    } catch (_) { /* cache miss — fall through to generation */ }
  }

  const rawCat   = marketCategory.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 50) || null;
  const category = PM_CATS.has(rawCat) ? rawCat : 'prediction-markets';
  const rawSport = typeof sport === 'string' ? sport.replace(/[^a-zA-Z]/g, '').slice(0, 20) : null;

  const [reputation, contextGraph, gameContext] = await Promise.all([
    readReputation(supabase),
    supabase ? buildContextGraph(supabase, { category }).catch(() => null) : Promise.resolve(null),
    category === 'sports' ? findGameContextForQuestion(question, rawSport, daysLeft).catch(() => null) : Promise.resolve(null),
  ]);
  const trackRecordSection = formatContextForPrompt(contextGraph);

  // Empirical "similar statline" lookup — only meaningful once a game is
  // actually live and there's a real trailing/leading side to ask about.
  const historicalSituation = (gameContext?.state === 'in' && supabase)
    ? await findSimilarSituations(supabase, {
        league: gameContext.league,
        period: gameContext.period,
        scoreDiff: (gameContext.homeScore ?? 0) - (gameContext.awayScore ?? 0),
        secondsRemaining: gameContext.secondsRemaining,
        isPlayoff: gameContext.isPlayoff,
      }).catch(() => null)
    : null;

  try {
    const profile = CATEGORY_SOURCE_PROFILES[category];
    let items = [];           // class: 'news' — shown in "Recent news"
    let redditPosts = [];     // class: 'reddit' — shown in "Public sentiment"
    let structuredItems = []; // class: 'structured' — shown in "Official/structured data"
    let searchQuery;
    let leanNote = '';
    let sourceTypeMap = {};   // source name -> sourceType, for reward-loop tagging at save time
    let sourceVolumeMap = {}; // source name -> coverageVolume, for reward-loop tagging at save time

    if (profile) {
      const entities = profile.buildQuery(question, rawSport);
      searchQuery = entities.rawQuery;

      const results = await Promise.allSettled(profile.fetchers.map(f => f(question, entities)));
      let fetched = [];
      for (const r of results) if (r.status === 'fulfilled') fetched.push(...r.value);

      // Relevance filter: for broadly-fetched news items, keep only ones mentioning an
      // extracted entity. Structured/ESPN-team-filtered items are already targeted upstream.
      const keywords = [
        ...(entities.teams || []).map(t => t.full),
        ...(entities.players || []),
        ...(entities.entities || []),
      ].filter(Boolean);
      if (keywords.length) {
        fetched = fetched.filter(i =>
          i.class !== 'news' ||
          i.sourceType === 'beat_reporter_news' ||
          keywords.some(k => i.title.toLowerCase().includes(k.toLowerCase()))
        );
      }

      fetched = fetched.map(i => ({ ...i, grade: i.grade || getSourceGrade(i.source) }));
      const allocated = allocateBudget(fetched);
      for (const i of allocated) {
        if (i.sourceType) sourceTypeMap[i.source] = i.sourceType;
        if (i.coverageVolume) sourceVolumeMap[i.source] = Math.max(sourceVolumeMap[i.source] || 0, i.coverageVolume);
      }

      structuredItems = allocated.filter(i => i.class === 'structured');
      items = allocated.filter(i => i.class === 'news').map(i => {
        const rep = reputation[i.source];
        const empirical = rep && rep.attempts >= 10
          ? `, ${Math.round(rep.correct / rep.attempts * 100)}% empirical (${rep.attempts} tracked)`
          : '';
        return { title: i.title, source: i.source, grade: i.grade, empirical, coverageVolume: i.coverageVolume || 1 };
      });
      redditPosts = allocated.filter(i => i.class === 'reddit').map(i => i.title);

      if (category === 'politics') {
        const note = politicalLeanNote(allocated.filter(i => i.class === 'news'));
        if (note) leanNote = `\n${note}\n`;
      }
    } else {
      // Fallback for unrecognized/'prediction-markets' category — original generic
      // behavior, delegated to fetchLegacyGeneric (lib/market-source-profiles.js) so
      // this stays the single source of truth scripts/compare-token-usage.js measures
      // against, instead of a second inline copy that could silently drift out of sync.
      const legacy = await fetchLegacyGeneric(question);
      searchQuery = legacy.searchQuery;
      redditPosts = legacy.redditPosts;
      items = legacy.items.map(i => {
        const grade = getSourceGrade(i.source);
        const rep = reputation[i.source];
        const empirical = rep && rep.attempts >= 10
          ? `, ${Math.round(rep.correct / rep.attempts * 100)}% empirical (${rep.attempts} tracked)`
          : '';
        return { title: i.title, source: i.source, grade, empirical };
      });
    }

    if (items.length === 0 && redditPosts.length < 3 && structuredItems.length === 0 && !gameContext) {
      return {
        lean: 'Uncertain',
        lean_confidence: 'Low',
        reasoning: 'No relevant news or public discussion found for this question. The market odds are the best available signal.',
        key_sources: [],
        signal: 'Inconclusive',
        signal_detail: 'No news coverage found to compare against the market odds.',
        articlesFound: 0,
        searchQuery
      };
    }

    const oddsContext = currentOdds !== undefined
      ? `Current market odds: ${currentOdds}% chance of YES`
      : 'Market odds: not provided';

    const redditSection = redditPosts.length
      ? `\nPublic sentiment on Reddit (${redditPosts.length} posts):\n${redditPosts.map(p => `- "${p}"`).join('\n')}\nThis is what regular people are actively discussing — factor it in as a crowd sentiment signal, especially for questions driven by public opinion.\n`
      : '';

    const structuredSection = structuredItems.length
      ? `\nOfficial/structured data (${structuredItems.length} items — filings, rosters, bills, disclosures):\n${structuredItems.map(i => `- [${i.sourceType}] ${i.title}`).join('\n')}\n`
      : '';

    // Live/pregame ESPN game data (NFL/NBA only for now — see lib/espn-live.js).
    // Grounds the analysis in the actual score/clock/injuries/Vegas line instead
    // of relying on news headlines alone, and lets Claude reason about a game
    // that's actually in progress rather than just pre-game odds.
    const liveGameSection = gameContext ? `
Live game data (from ESPN, ${gameContext.state === 'in' ? 'GAME IN PROGRESS' : gameContext.state === 'post' ? 'game completed' : 'pregame'}):
- Status: ${gameContext.statusDetail || gameContext.state}${gameContext.period ? `, period ${gameContext.period}` : ''}${gameContext.clock ? `, clock ${gameContext.clock}` : ''}
- Score: ${gameContext.awayTeam} ${gameContext.awayScore ?? '-'} at ${gameContext.homeTeam} ${gameContext.homeScore ?? '-'}${gameContext.venue ? ` (${gameContext.venue})` : ''}${gameContext.isPlayoff ? ' — PLAYOFF GAME' : ''}
${gameContext.predictor ? `- ESPN's win probability model: ${gameContext.homeTeam} ${gameContext.predictor.homeWinPct}%, ${gameContext.awayTeam} ${gameContext.predictor.awayWinPct}%\n` : ''}${gameContext.vegasLine ? `- Vegas line (${gameContext.vegasLine.provider}): ${gameContext.vegasLine.spread}, moneyline ${gameContext.homeTeam} ${gameContext.vegasLine.homeMoneyLine} / ${gameContext.awayTeam} ${gameContext.vegasLine.awayMoneyLine}, over/under ${gameContext.vegasLine.overUnder}\n` : ''}${(gameContext.injuries.home.length || gameContext.injuries.away.length) ? `- Injuries: ${gameContext.homeTeam}: ${gameContext.injuries.home.map(i => `${i.player} (${i.status})`).join(', ') || 'none listed'}. ${gameContext.awayTeam}: ${gameContext.injuries.away.map(i => `${i.player} (${i.status})`).join(', ') || 'none listed'}.\n` : ''}${historicalSituation ? `- Historical comparison: in ${historicalSituation.sampleSize} past ${gameContext.league.toUpperCase()} games with a similar score and time situation, the trailing team came back to win ${historicalSituation.trailingTeamWinRate}% of the time.\n` : ''}${gameContext.state === 'in' ? 'This game is live right now — weigh the current score, period, and clock (and the historical comparison above, if present) heavily. A team down by a wide margin late in the game is a strong signal regardless of what pregame news said.\n' : ''}` : '';

    const prompt = `You are helping everyday users understand a prediction market question using recent news and public sentiment.

Market question: "${question}"
${oddsContext}
${liveGameSection}
Recent news (${items.length} articles):
${items.map(i => `- "${i.title}" — ${i.source} [${i.grade}${i.empirical}${i.coverageVolume > 1 ? `, ${i.coverageVolume}x coverage` : ''}]`).join('\n')}
${structuredSection}${redditSection}${leanNote}${trackRecordSection}
Weight news sources by grade (High > Medium > Low). Treat official/structured data (filings, rosters, bills, disclosures) as a stronger factual signal than ordinary news when both are present. "Nx coverage" means N outlets ran essentially the same story — high coverage volume can mean the news is well-confirmed, but it can also mean the market has already priced in a widely-known story, so don't automatically treat heavy coverage as a bigger edge than a single high-grade or official source. Use Reddit posts as a crowd sentiment signal — they show which way public opinion is leaning, which directly influences prediction market odds. Be direct — if sources clearly point one way, say so.

Consider: official statements, confirmed facts, injury reports, results, direct reporting.

ALREADY RESOLVED: If the news or your knowledge clearly shows this event has already happened and the outcome is known (a game was played, a vote occurred, an elimination already happened), set lean to "Uncertain" and explain in reasoning that the event is already resolved. Do NOT predict past events. Only predict genuinely uncertain future outcomes.

TRACK RECORD CALIBRATION: If the PLATFORM TRACK RECORD section above shows this category has been less reliable historically, lower your confidence and require stronger evidence before leaning Yes or No. If it shows strong accuracy in this category, bolder leans are appropriate.

DIRECTION COMMITMENT: For genuinely future uncertain events, reserve "Uncertain" only for true deadlock — when credible sources split almost evenly AND crowd odds are within 5% of 50/50 AND your domain knowledge offers no tiebreaker. If the news has ANY directional tilt (even slight), commit to Yes or No. "Uncertain" should be rare for future events.

Write for a general audience — plain conversational English, no analyst jargon. Avoid vague phrases like "coverage suggests", "sentiment indicates", "market dynamics". Write the way you'd explain it to a curious friend. Do NOT use em dashes (—) anywhere in your response; use commas, colons, or periods instead.

Respond ONLY with valid JSON, no markdown:
{
  "lean": "Yes" | "No" | "Uncertain",
  "lean_confidence": "High" | "Medium" | "Low",
  "crowd_summary": "One sentence describing what the crowd's odds actually mean — use the question to name the specific outcome, always include the ${currentOdds !== undefined ? currentOdds + '%' : 'market'} figure, e.g. 'The crowd is 52% confident the Warriors will win the series' or 'Bettors are 68% sure the Strait of Hormuz reopens this month'",
  "reasoning": "2-3 plain-English sentences on what the news specifically says — name teams, people, or events from the actual articles, say what was reported or confirmed, don't be vague or hedge everything",
  "key_sources": ["source1", "source2"],
  "signal": "Aligns with market" | "Contradicts market" | "Inconclusive",
  "signal_detail": "One conversational sentence on whether the news agrees or disagrees with the crowd — e.g. 'The news strongly backs what the crowd is betting on' or 'The news tells a different story from what the crowd thinks'"
}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await apiRes.json();
    if (data.error) {
      console.error('[runMarketAnalysis] Anthropic error:', data.error.message);
      return { error: 'Analysis failed', status: 500 };
    }

    const raw = data.content[0].text.replace(/```json|```/g, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(raw);
    } catch (_) {
      return { error: 'Analysis service returned invalid data', status: 500 };
    }

    const lean = (analysis.lean || '').trim();
    let predictionSaved = false;
    let saveError = null;
    if (supabase && (lean === 'Yes' || lean === 'No')) {
      // Only set a validation_date when Polymarket provided an actual end date.
      // Without a real end date, leave null — news-grade scan will stamp the date
      // once the outcome is confirmed. A made-up date causes misleading "Jul 12"-style
      // display before grading.
      const validationDate = daysLeft != null
        ? new Date(Date.now() + daysLeft * 86400000).toISOString()
        : null;
      const savedAnalysis = { ...analysis, lean, impact_timeframe: daysLeft ? `${daysLeft} days` : null };
      if (baselineGenerated) savedAnalysis.baseline_generated = true;
      // Tag which sourcing methodology produced this row — see SOURCING_VERSION in
      // lib/market-source-profiles.js. Only set when the category-aware profile path
      // actually ran; absence marks a row as generated by the old generic fallback.
      if (profile) savedAnalysis.sourcing_version = SOURCING_VERSION;

      const momentum = await _computeOddsMomentum(supabase, slug, currentOdds ?? null);
      const contrarian = _isContrarian(lean, momentum.direction);
      const sourceTypes = _resolveSourceTypes(analysis.key_sources, sourceTypeMap);
      const coverageVolumeBucket = _resolveVolumeBucket(analysis.key_sources, sourceVolumeMap);

      const { error: insertErr } = await supabase.from('predictions').insert({
        id:                  `pm_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        created_at:          new Date().toISOString(),
        topic:               question,
        sources:             items.map(i => i.source),
        lean,
        lean_confidence:     (analysis.lean_confidence || '').trim() || null,
        market_odds_at_time: currentOdds ?? null,
        market_slug:         slug || null,
        signal:              analysis.signal || null,
        category,
        analysis:            savedAnalysis,
        validation_date:     validationDate,
        winner_tickers:      [],
        loser_tickers:       [],
        correct:             null,
        notes:               null,
        source_types:        sourceTypes,
        contrarian,
        odds_momentum_at_time: momentum,
        coverage_volume_bucket: coverageVolumeBucket,
      });
      if (insertErr) {
        console.error('[runMarketAnalysis] save error:', insertErr.message, insertErr.code);
        saveError = insertErr.message;
      } else {
        predictionSaved = true;
      }
    }

    return { ...analysis, lean, articlesFound: items.length, searchQuery, predictionSaved, ...(gameContext ? { liveGame: gameContext } : {}), ...(historicalSituation ? { historicalSituation } : {}), ...(saveError ? { _saveError: saveError } : {}) };
  } catch (err) {
    console.error('[runMarketAnalysis]', err.message);
    return { error: 'Analysis failed', status: 500 };
  }
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const supabase = _getSupabase();
  const allowed = await _checkRateLimit(supabase, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const rawQuestion = req.body?.question;
  const rawOdds = req.body?.currentOdds;
  const rawCategory = typeof req.body?.marketCategory === 'string' ? req.body.marketCategory : '';

  const question = _sanitize(rawQuestion, 300);
  if (!question) return res.status(400).json({ error: 'No question provided' });

  const currentOdds = (typeof rawOdds === 'number' && rawOdds >= 0 && rawOdds <= 100)
    ? Math.round(rawOdds)
    : undefined;

  const daysLeft = typeof req.body?.daysLeft === 'number' ? req.body.daysLeft : null;
  const slug     = req.body?.slug || null;
  const sport    = typeof req.body?.sport === 'string' ? _sanitize(req.body.sport, 20) : null;

  const result = await runMarketAnalysis({ supabase, question, currentOdds, marketCategory: rawCategory, slug, daysLeft, sport });
  if (result?.error) return res.status(result.status || 500).json({ error: result.error });
  return res.status(200).json(result);
}
