import { createClient } from '@supabase/supabase-js';

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

function getSourceGrade(source) {
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

  const [searchQuery, reputation] = [buildSearchQuery(question), await readReputation(supabase)];

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
    const redditUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(searchQuery)}&sort=relevance&t=week&limit=10`;

    const [rssRes, redditRes] = await Promise.all([
      fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }),
      fetch(redditUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }).catch(() => null)
    ]);

    const rssText = await rssRes.text();
    const redditText = redditRes ? await redditRes.text().catch(() => '') : '';

    const items = [];
    const matches = [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    for (const match of matches.slice(0, 15)) {
      const item = match[1];
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
      const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : 'Unknown';
      if (title.length > 10) {
        const grade = getSourceGrade(source);
        const rep = reputation[source];
        const empirical = rep && rep.attempts >= 10
          ? `, ${Math.round(rep.correct / rep.attempts * 100)}% empirical (${rep.attempts} tracked)`
          : '';
        items.push({ title, source, grade, empirical });
      }
    }

    const redditPosts = [];
    if (redditText) {
      for (const match of [...redditText.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8)) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
        if (titleMatch) {
          const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
          if (title.length > 10) redditPosts.push(title);
        }
      }
    }

    if (items.length < 3 && redditPosts.length === 0) {
      return res.status(200).json({
        lean: 'Uncertain',
        lean_confidence: 'Low',
        reasoning: `Only ${items.length} article${items.length === 1 ? '' : 's'} found — not enough coverage to form a reliable lean. The market price is the best available signal.`,
        key_sources: [],
        signal: 'Inconclusive',
        signal_detail: 'Insufficient news coverage to compare against the market odds.',
        articlesFound: items.length,
        searchQuery
      });
    }

    const oddsContext = currentOdds !== undefined
      ? `Current market odds: ${currentOdds}% chance of YES`
      : 'Market odds: not provided';

    const redditSection = redditPosts.length
      ? `\nPublic sentiment on Reddit (${redditPosts.length} posts):\n${redditPosts.map(p => `- "${p}"`).join('\n')}\nThis is what regular people are actively discussing — factor it in as a crowd sentiment signal, especially for questions driven by public opinion.\n`
      : '';

    const prompt = `You are helping everyday users understand a prediction market question using recent news and public sentiment.

Market question: "${question}"
${oddsContext}

Recent news (${items.length} articles):
${items.map(i => `- "${i.title}" — ${i.source} [${i.grade}${i.empirical}]`).join('\n')}
${redditSection}
Weight news sources by grade (High > Medium > Low). Use Reddit posts as a crowd sentiment signal — they show which way public opinion is leaning, which directly influences prediction market odds. Be direct — if sources clearly point one way, say so.

Consider: official statements, confirmed facts, injury reports, results, direct reporting. If the question may already be resolved, note that.

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
      console.error('[market-analyze] Anthropic error:', data.error.message);
      return res.status(500).json({ error: 'Analysis failed' });
    }

    const raw = data.content[0].text.replace(/```json|```/g, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(raw);
    } catch (_) {
      return res.status(500).json({ error: 'Analysis service returned invalid data' });
    }

    if (supabase) {
      const category = rawCategory.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 50) || null;
      supabase.from('predictions').insert({
        id: `pred_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        created_at: new Date().toISOString(),
        type: 'prediction-markets',
        topic: question,
        sources: items.map(i => i.source),
        lean: analysis.lean || null,
        lean_confidence: analysis.lean_confidence || null,
        market_odds_at_time: currentOdds ?? null,
        market_slug: req.body?.slug || null,
        signal: analysis.signal || null,
        category,
        analysis,
        correct: null,
        notes: null
      }).then(() => {}).catch(e => console.error('[market-analyze] save error:', e.message));
    }

    return res.status(200).json({ ...analysis, articlesFound: items.length, searchQuery });
  } catch (err) {
    console.error('[market-analyze]', err.message);
    return res.status(500).json({ error: 'Analysis failed' });
  }
}
