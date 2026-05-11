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
- Discuss any US stock, ETF, sector, or market theme in depth
- Explain how to interpret the analysis cards, odds, and confidence ratings
- Help users think through an investment thesis or event they're tracking
- Explain prediction market mechanics and how to read odds
- Answer site navigation or functionality questions

RULES:
- You are NOT a licensed financial advisor. Never give direct "buy" or "sell" commands. Help users think, not just act.
- Always recommend doing independent research and consulting a financial professional for actual investment decisions.
- Be concise. Favor 2–4 sentences over long walls of text unless the question demands depth.
- Do not make up real-time prices or live data you don't have — acknowledge the limitation.
- You can use markdown formatting lightly (bold, bullet points) — the chat renders basic formatting.`;

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

  const pageDesc = PAGE_DESCRIPTIONS[pageContext] || PAGE_DESCRIPTIONS.general;
  const contextualSystem = `${SYSTEM_PROMPT}\n\nCURRENT PAGE CONTEXT: ${pageDesc}`;

  // Cap history to last 12 messages to keep costs reasonable
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
        max_tokens: 600,
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
