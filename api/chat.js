import { createClient } from '@supabase/supabase-js';
import { buildContextGraph, formatContextForChat } from '../lib/context-graph.js';

// Module-level headline cache — shared across warm invocations, 5-min TTL
const _headlineCache = new Map();

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
  const key = `${ip}:chat`;
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

const PAGE_DESCRIPTIONS = {
  'stock-markets':      'The user is on the Stock Markets page. It groups live US financial news by topic, analyzes market impact, identifies winning/losing US-listed stocks and ETFs for each event, and assigns 1-5 star confidence ratings. Users can also search any individual stock ticker for a dedicated analysis.',
  'prediction-markets': 'The user is on the Prediction Markets page. It shows live Polymarket odds (20-80% only — the genuine uncertainty zone) with an AI lean (Yes/No), confidence level, and signal (Aligns with market / Contradicts market). Categories: Politics, Sports, Entertainment, Finance, Tech.',
  'crypto':             'The user is on the Crypto Markets page. It shows live prices and AI analysis for 30+ crypto assets. Fear & Greed Index is displayed. News is grouped by event, same direction/confidence system as Stock Markets. Individual coin deep-dives available.',
  'accuracy':           'The user is on the Prediction Performance (Track Record) page. It shows the platform\'s overall accuracy, a cumulative score chart, top tickers ranked by win rate, and a filterable list of all graded predictions. Grades: A (≥60 pts), B (≥25), C (≥0), D (≥-25), F (<-25). The accuracy metric uses a lenient threshold (score > -15) to reflect directionally correct calls.',
  'home':               'The user is on the Infoblade home page.',
  'general':            'The user is on the Infoblade platform.',
};

const SYSTEM_PROMPT = `You are the AI Informant on Infoblade, a financial intelligence platform. You know this platform completely — every feature, concept, and number. You are the navigator and explainer for everything here. Be sharp, helpful, and direct. You are NOT a licensed financial advisor — help users think, not just act.

THE PLATFORM: THREE LIVE SECTIONS + TRACK RECORD

**Stock Markets**
Groups live US financial news by topic using real-time feeds (Reuters, Bloomberg, WSJ, CNBC, Benzinga, GDELT, Reddit, and more). For each news event the AI identifies: direction (bullish / bearish / uncertain), affected US-listed stocks and ETFs split into winners (predicted up) and losers (predicted down), a 1-5 star confidence rating, the impact timeframe, and Polymarket crowd odds for related events.
Source weighting: High-grade sources (Reuters, Bloomberg, WSJ, AP) carry 1.0x weight; Medium (CNBC, MarketWatch, Yahoo Finance, Benzinga) carry 0.7x; Low (Reddit, ZeroHedge) carry 0.4x. Only the net weighted consensus determines the direction call.
Stock-specific analysis: users can search any US ticker or company name for a dedicated analysis. Impact windows: 1 Week, 1 Month, 3 Months, 6 Months.
Category filters: General Markets, Macro/Monetary, Technology, Energy, Financials, Precious Metals, Real Estate, Consumer/Retail, Healthcare, Defense & Aerospace.
Every prediction is automatically saved and graded when its timeframe expires.

**Crypto Markets**
Live analysis for 30+ crypto assets. Shows the Fear & Greed Index (0-100 — low means fear/potential oversold, high means greed/potential overbought). News is grouped by event with the same direction/confidence system as Stock Markets. Uses crypto-specific sources: CoinDesk, The Block, Decrypt, Forkast, plus r/CryptoCurrency and r/Bitcoin. Individual coin deep-dives available. Affected crypto-adjacent stocks (COIN, MSTR, IBIT, MARA) are tracked as proxy US-listed assets since coins themselves are not NYSE/NASDAQ listed.

**Prediction Markets**
Shows live Polymarket markets for financial, political, sports, and entertainment events. Only 20-80% YES odds are displayed — the genuine uncertainty zone. Near-certainties (>80%) and near-impossibilities (<20%) are filtered out because they offer no signal value. Volume figures show how much real money backs each market. For each market the AI produces: a lean (Yes or No), confidence (High/Medium/Low), reasoning from current news, and a signal. "Aligns with market" means the AI's read matches the crowd. "Contradicts market" is a contrarian call. "Inconclusive" means evidence is split. Every lean is saved and graded when the Polymarket market resolves.

**Track Record / Prediction Performance**
The platform logs every prediction it makes and grades them automatically. When a prediction's timeframe expires, actual Yahoo Finance prices are fetched and the outcome is scored. Scoring: each ticker earns ±pts = (actual % move in predicted direction) × 10, capped at ±100. A bullish call where the stock moved +4.98% earns +49.8 pts. A bearish call where the stock moved +3.22% in the wrong direction earns -32.2 pts. A hit-rate bonus (up to ±10 pts) rewards getting direction right on more tickers. Final score = average per-ticker pts + bonus. Grades: A (≥60), B (≥25), C (≥0), D (≥-25), F (<-25). The displayed accuracy uses a lenient threshold — predictions with score > -15 count as effectively correct, giving benefit of the doubt to borderline calls that were directionally right but below the 0.5% movement threshold.
The track record feeds back into every new analysis: the AI sees its own win rate per ticker and sector, and calibrates its confidence accordingly (e.g., if bearish NVDA calls have been wrong 3 times, a new bearish NVDA call requires stronger evidence and gets capped confidence).

KEY CONCEPTS (answer these precisely if asked):

*Impact timeframe* — the window over which the prediction is expected to play out. "Immediate within 48 hours" = the price effect is expected within 2 trading days. "Over the next 2-4 weeks" = medium-term catalyst. The AI assigns the timeframe most appropriate to the event type: earnings shocks are 48h; policy changes, 2-4 weeks; structural shifts, 1-3 months. This timeframe also determines when the prediction is auto-graded.

*Confidence stars (1-5)* — how strong the directional signal is, based on: quality and volume of sources, source consensus, historical platform accuracy on similar events or tickers, and directness of the causal chain. 5 stars means multiple high-grade sources agree with a clear mechanism and the platform has been accurate in this category. 3 stars is the minimum shown. 1-2 stars are filtered out entirely. The AI is calibrated to cap confidence when its track record on a specific ticker or sector direction is poor.

*Winners vs losers* — winner tickers are stocks/ETFs predicted to rise from this event; loser tickers are predicted to fall. A stock only appears if there is a specific, direct causal link to the event — not just because it is a large-cap in a related sector. Generic correlations are explicitly excluded.

*Source quality grades* — High: Reuters, AP, Bloomberg, FT, WSJ, BBC, NPR, The Economist, CNBC, Politico. Medium: MarketWatch, Yahoo Finance, Benzinga, TheStreet, Zacks, TechCrunch, The Verge, Forbes, CoinDesk, The Block. Low: Reddit communities, ZeroHedge, Fox News, Cointelegraph. Unknown sources get 0.2x weight.

*Validation / auto-grading* — runs automatically every 6 hours via a cron job. When a prediction's impact timeframe expires, Yahoo Finance historical prices are fetched for each ticker, the actual % move is computed from baseline price (at prediction time) to actual price (at validation date), and the grade is recorded. No human editing is involved.

*Polymarket odds* — real-money probabilities. A 67% YES means bettors collectively estimate a 67% chance the event happens. Polymarket has processed billions in real-money trades, making these odds a serious crowd signal. The odds shown are live and update in real time.

*The self-learning calibration* — before every new analysis, the platform builds a "context graph" of its own past performance: overall accuracy, per-sector accuracy (both bullish and bearish separately), per-ticker win rate (bullish vs bearish direction tracked separately), and examples of recent wrong predictions. This context is injected into every Claude prompt so the AI knows where it has been systematically right or wrong and adjusts accordingly.

HOW TO HELP USERS:
- Answer any question about how the site works: features, concepts, numbers, what to click, how to interpret results
- When live news headlines are provided below, synthesize them into real analysis with specific affected stocks and sector implications
- Discuss any US stock, ETF, sector, crypto asset, or market theme in depth
- Help users think through an investment thesis or event they are tracking
- Explain prediction market mechanics and how to read odds
- Walk through what a specific prediction grade means and why

RULES:
- When live headlines are provided, lead with what you actually see in the news, then add broader context
- Be conversational but analytical, like a sharp research analyst, not a disclaimer machine
- Use markdown: **bold** for key terms, bullet points for lists, numbered lists for steps. NEVER use # or ## headings. Use **bold** instead to label sections
- Do NOT use em dashes (—) anywhere in your response. Use commas, colons, or periods instead`;

// Fetch live headlines for a given query from Google News RSS (5-min cache)
async function fetchLiveHeadlines(query) {
  const cacheKey = query.slice(0, 120);
  const cached = _headlineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 300000) return cached.headlines;

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    clearTimeout(t);
    const text = await res.text();
    const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    const headlines = [];
    for (const match of items.slice(0, 12)) {
      const item = match[1];
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
      const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      if (titleMatch) {
        const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
        const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : '';
        const pub = pubDateMatch ? new Date(pubDateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        if (title.length > 15) headlines.push(`- "${title}"${source ? ` — ${source}` : ''}${pub ? ` (${pub})` : ''}`);
      }
    }
    _headlineCache.set(cacheKey, { headlines, ts: Date.now() });
    return headlines;
  } catch (e) {
    clearTimeout(t);
    return [];
  }
}

// Extract ticker symbols mentioned in a message ($NVDA, (NVDA), or plain NVDA 2–5 caps)
function extractTickers(text) {
  const matches = [
    ...text.matchAll(/\$([A-Z]{1,5})\b/g),
    ...text.matchAll(/\(([A-Z]{2,5})\)/g),
    ...text.matchAll(/\b([A-Z]{2,5})\b/g),
  ];
  const exclude = new Set(['AI', 'US', 'UK', 'EU', 'GDP', 'CPI', 'IPO', 'ETF', 'SEC', 'FED', 'CEO', 'CFO', 'USD', 'EUR']);
  return [...new Set(matches.map(m => m[1]).filter(t => !exclude.has(t)))].slice(0, 10);
}

// Detect if the message is asking about live market news/prices (vs site functionality/concepts)
// Site-how-it-works questions should NOT trigger headline fetching
function isMarketQuestion(text) {
  const lower = text.toLowerCase();
  // Site-functionality questions: skip headline fetch, Claude knows the answer from system prompt
  const siteQuestions = [
    'how does', 'what does', 'what is', 'what are', 'explain', 'mean', 'work',
    'confidence star', 'impact timeframe', 'winner', 'loser', 'grade', 'score',
    'accuracy', 'validation', 'prediction market', 'polymarket', 'odds', 'signal',
    'aligns', 'contradicts', 'fear and greed', 'fear & greed', 'how is', 'why only',
    'how do i', 'how to', 'what happen', 'navigate', 'site', 'page', 'section',
    'track record', 'grading', 'a grade', 'b grade', 'c grade', 'a-f', 'difference between',
  ];
  if (siteQuestions.some(q => lower.includes(q))) return false;
  const marketTerms = [
    'stock', 'ticker', 'etf', 'sector', 'price', 'earnings', 'news',
    'invest', 'trade', 'buy', 'sell', 'short', 'crypto', 'bitcoin', 'fed',
    'rate', 'inflation', 'recession', 'gdp', 'treasury', 'bond', 'yield',
    'ipo', 'nasdaq', 'nyse', 's&p', 'dow', 'index', 'quarter', 'revenue',
    'profit', 'loss', 'guidance', 'analyst', 'upgrade', 'downgrade', 'target',
    'moving', 'surge', 'drop', 'rally', 'crash', 'bull', 'bear',
    'today', 'latest', 'recent', 'this month', 'happening', 'right now',
  ];
  return marketTerms.some(term => lower.includes(term));
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated user
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Sign in to use AI Chat.' });
  const supabase = _getSupabase();
  if (supabase) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Sign in to use AI Chat.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const allowed = await _checkRateLimit(supabase, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const { messages, pageContext } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  // Fetch live headlines + context graph in parallel when market-related
  const mentionedTickers = extractTickers(lastUserMsg);
  let liveContext = '';
  if (isMarketQuestion(lastUserMsg)) {
    const query = lastUserMsg.slice(0, 120) + ' stock market';
    const [headlines, contextGraph] = await Promise.all([
      fetchLiveHeadlines(query),
      supabase && mentionedTickers.length
        ? buildContextGraph(supabase, { tickers: mentionedTickers }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (headlines.length > 0) {
      liveContext = `\n\nLIVE NEWS HEADLINES (fetched right now from Google News — use these to answer the user's question):\n${headlines.join('\n')}\n\nAnalyze the above headlines and use them as the basis for your response. Identify which stocks, sectors, or ETFs are affected and explain the market implications.`;
    }
    const trackRecord = formatContextForChat(contextGraph);
    if (trackRecord) liveContext += trackRecord;
  }

  const pageDesc = PAGE_DESCRIPTIONS[pageContext] || PAGE_DESCRIPTIONS.general;
  // Split into static (cacheable) + dynamic parts so Anthropic caches the large static prompt
  const dynamicContext = `\n\nCURRENT PAGE CONTEXT: ${pageDesc}${liveContext}`;

  const trimmed = messages.slice(-12).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 2000)
  }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicContext },
        ],
        messages: trimmed,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await response.json();
    if (data.error) {
      console.error('[chat] Anthropic error:', data.error.message);
      return res.status(500).json({ error: 'Chat service unavailable' });
    }

    const reply = data.content?.[0]?.text || '';
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('[chat]', err.message);
    return res.status(500).json({ error: 'Chat request failed' });
  }
}
