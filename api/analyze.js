export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const newsRes = await fetch(
        `https://gnews.io/api/v4/search?q=economy OR "interest rates" OR "federal reserve" OR inflation OR tariffs OR "trade policy" OR OPEC OR "oil prices" OR recession OR "central bank" OR "earnings report" OR GDP OR "stock market"&lang=en&max=10&sortby=publishedAt&apikey=${process.env.GNEWS_KEY}`
      );
      const newsData = await newsRes.json();

      if (!newsData.articles || newsData.articles.length === 0) {
        return res.status(200).json({ articles: [] });
      }

      const economicKeywords = [
        'economy', 'market', 'stock', 'fed', 'federal reserve', 'rate', 'inflation',
        'gdp', 'trade', 'tariff', 'oil', 'opec', 'recession', 'bank', 'earnings',
        'revenue', 'profit', 'loss', 'investment', 'debt', 'deficit', 'export',
        'import', 'supply chain', 'semiconductor', 'energy', 'dollar', 'bond',
        'treasury', 'wall street', 'nasdaq', 'dow', 's&p', 'crypto', 'bitcoin',
        'merger', 'acquisition', 'ipo', 'layoff', 'hiring', 'unemployment', 'jobs',
        'housing', 'mortgage', 'retail', 'consumer', 'manufacturing', 'output',
        'sanctions', 'crude', 'natural gas', 'agriculture', 'shipping', 'port',
        'logistics', 'china', 'europe', 'imf', 'world bank'
      ];

      const seen = new Set();
      const articles = newsData.articles
        .filter(a => {
          const title = a.title.toLowerCase();
          return economicKeywords.some(keyword => title.includes(keyword));
        })
        .filter(a => {
          const key = a.title.substring(0, 40);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(a => ({
          title: a.title,
          source: a.source.name,
          date: a.publishedAt
        }));

      return res.status(200).json({ articles });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { headline } = req.body;

    if (!headline) {
      return res.status(400).json({ error: 'No headline provided' });
    }

    try {
      const filterRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 10,
          messages: [{
            role: 'user',
            content: `Does this headline have direct implications for financial markets, stocks, or the economy? Reply only "yes" or "no".

"${headline}"`
          }]
        })
      });

      const filterData = await filterRes.json();
      const relevant = filterData.content[0].text.trim().toLowerCase();

      if (relevant === 'no') {
        return res.status(200).json({ irrelevant: true });
      }

      const prompt = `You are a financial analyst AI. Analyze this news headline for market implications:

"${headline}"

Respond ONLY with a valid JSON object, no markdown, no extra text:

{
  "why_it_matters": "2-3 sentence explanation of the economic significance",
  "sectors": {
    "positive": ["sector1", "sector2"],
    "negative": ["sector3"],
    "neutral": []
  },
  "winners": {
    "explanation": "1-2 sentences on why these companies benefit",
    "tickers": ["TICK1", "TICK2", "TICK3"]
  },
  "losers": {
    "explanation": "1-2 sentences on why these companies are hurt",
    "tickers": ["TICK4", "TICK5"]
  },
  "confidence": "High/Medium/Low — brief reason"
}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });

      const raw = data.content[0].text;
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const analysis = JSON.parse(cleaned);

      return res.status(200).json(analysis);

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
