const PAGE_DESCRIPTIONS = {
  'stock-markets': 'The user is on the Stock Markets page, which analyzes US market-moving news events. It groups headlines by topic, rates predicted market impact, identifies winning/losing US-listed stocks and ETFs, and assigns a 1-5 star confidence rating.',
  'prediction-markets': 'The user is on the Prediction Markets page, which shows live Polymarket odds for financial and economic events. It only shows markets with 20–80% YES odds (the genuine uncertainty zone). Volume figures indicate how much real money is behind each market.',
  'crypto': 'The user is on the Crypto Markets page. This section is currently under construction / coming soon.',
  'home': 'The user is on the InvestmentInformatics.AI home page.',
  'general': 'The user is on the InvestmentInformatics.AI platform.',
};

const SYSTEM_PROMPT = `You are the AI Informant embedded in InvestmentInformatics.AI, a financial intelligence platform. You are helpful, sharp, and concise.

THE PLATFORM HAS THREE TOOLS:
1. Stock Markets — Groups live US financial news by topic, analyzes each event's market impact using Goldman Sachs-style reasoning, identifies which US-listed stocks/ETFs benefit or suffer, and rates prediction confidence 1–5 stars (5 = highest). Only topics with 3+ stars are shown. Sources are graded by factuality (High/Medium/Low) and weighted accordingly.
2. Prediction Markets — Aggregates live Polymarket odds for financial and economic events. Polymarket is a real-money prediction market; prices represent crowd consensus probability in percentage form. Only markets with 20–80% odds are shown (genuine uncertainty zone).
3. Crypto Markets — Coming soon.

ACCURACY HISTORY — Tracks the platform's own track record of past predictions over time.

HOW CONFIDENCE STARS WORK (Stock Markets):
- 5 stars: Very high confidence — multiple high-grade sources, strong consensus, clear market mechanism
- 4 stars: High confidence — solid sourcing, clear directional signal
- 3 stars: Moderate — some signal but limited sources or mixed signals
- 1–2 stars: Poor signal — filtered out and never shown

HOW TO HELP USERS:
- When you have live headlines provided below, use them as your primary source to answer market/news questions. Synthesize the headlines into a real analysis with specific stocks and sector implications.
- Discuss any US stock, ETF, sector, or market theme in depth
- Explain how to interpret the analysis cards, odds, and confidence ratings
- Help users think through an investment thesis or event they're tracking
- Explain prediction market mechanics and how to read odds
- Answer site navigation or functionality questions

RULES:
- You are NOT a licensed financial advisor. Never give direct "buy" or "sell" commands. Help users think, not just act.
- When live headlines are provided, lead with what you actually see in the news before adding broader context.
- Be conversational but analytical — like a sharp research desk, not a disclaimer machine.
- Use markdown formatting: **bold** for key terms, bullet points for lists, numbered lists for steps. NEVER use # or ## headings — this is a chat interface, not a document. Use **bold** instead of headings to label sections.`;

// Fetch live headlines for a given query from Google News RSS
async function fetchLiveHeadlines(query) {
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
    return headlines;
  } catch (e) {
    clearTimeout(t);
    return [];
  }
}

// Detect if the message is asking about market news/stocks (vs site functionality)
function isMarketQuestion(text) {
  const lower = text.toLowerCase();
  const marketTerms = [
    'stock', 'ticker', 'etf', 'market', 'sector', 'price', 'earnings', 'news',
    'invest', 'trade', 'buy', 'sell', 'short', 'crypto', 'bitcoin', 'fed',
    'rate', 'inflation', 'recession', 'gdp', 'treasury', 'bond', 'yield',
    'ipo', 'nasdaq', 'nyse', 's&p', 'dow', 'index', 'quarter', 'revenue',
    'profit', 'loss', 'guidance', 'analyst', 'upgrade', 'downgrade', 'target',
    'impact', 'affect', 'move', 'surge', 'drop', 'rally', 'crash', 'bull', 'bear',
    'week', 'today', 'latest', 'recent', 'this month', 'happening'
  ];
  return marketTerms.some(term => lower.includes(term));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, pageContext } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  // Fetch live headlines in parallel if the question is market-related
  let liveContext = '';
  if (isMarketQuestion(lastUserMsg)) {
    const query = lastUserMsg.slice(0, 120) + ' stock market';
    const headlines = await fetchLiveHeadlines(query);
    if (headlines.length > 0) {
      liveContext = `\n\nLIVE NEWS HEADLINES (fetched right now from Google News — use these to answer the user's question):\n${headlines.join('\n')}\n\nAnalyze the above headlines and use them as the basis for your response. Identify which stocks, sectors, or ETFs are affected and explain the market implications.`;
    }
  }

  const pageDesc = PAGE_DESCRIPTIONS[pageContext] || PAGE_DESCRIPTIONS.general;
  const contextualSystem = `${SYSTEM_PROMPT}\n\nCURRENT PAGE CONTEXT: ${pageDesc}${liveContext}`;

  const trimmed = messages.slice(-12).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content).slice(0, 2000)
  }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: contextualSystem,
        messages: trimmed
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const reply = data.content?.[0]?.text || '';
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
