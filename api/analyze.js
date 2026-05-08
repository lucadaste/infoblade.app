export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const newsRes = await fetch(
        `https://gnews.io/api/v4/search?q=economy OR "interest rates" OR "federal reserve" OR inflation OR tariffs OR "trade policy" OR OPEC OR "oil prices" OR recession OR "central bank" OR "earnings report" OR GDP OR "stock market"&lang=en&max=20&sortby=publishedAt&apikey=${process.env.GNEWS_KEY}`
      );
      const newsData = await newsRes.json();

      if (!newsData.articles || newsData.articles.length === 0) {
        return res.status(200).json({ groups: [] });
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

      // Filter to economic articles only
      const filtered = newsData.articles.filter(a => {
        const title = a.title.toLowerCase();
        return economicKeywords.some(k => title.includes(k));
      });

      // Group similar headlines using Claude
      const groupPrompt = `You are a news editor. Here are ${filtered.length} news headlines. Group them by topic — headlines covering the same event or story should be in the same group. Then give each group a clear, concise topic title (max 10 words) that summarizes the theme.

Headlines:
${filtered.map((a, i) => `${i + 1}. "${a.title}" — ${a.source.name}`).join('\n')}

Respond ONLY with valid JSON, no markdown:
{
  "groups": [
    {
      "topic": "Short topic title summarizing the theme",
      "indices": [1, 3, 5],
      "sources": ["Source A", "Source B"]
    }
  ]
}

Rules:
- Each index should appear in exactly one group
- Only include groups with genuine economic/market relevance
- Ignore non-economic stories entirely (don't include their indices)
- Maximum 6 groups
- indices are 1-based matching the numbered list above`;

      const groupRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1000,
          messages: [{ role: 'user', content: groupPrompt }]
        })
      });

      const groupData = await groupRes.json();
      const groupRaw = groupData.content[0].text.replace(/```json|```/g, '').trim();
      const grouped = JSON.parse(groupRaw);

      // Build groups with their articles
      const groups = grouped.groups.map(g => ({
        topic: g.topic,
        sources: g.sources,
        headlines: g.indices.map(i => filtered[i - 1]?.title).filter(Boolean),
        dates: g.indices.map(i => filtered[i - 1]?.publishedAt).filter(Boolean)
      }));

      return res.status(200).json({ groups });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { topic, headlines, sources } = req.body;

    if (!topic) return res.status(400).json({ error: 'No topic provided' });

    try {
      const prompt = `You are a financial analyst AI. Multiple news outlets are reporting on this market topic:

Topic: "${topic}"

Headlines covering this story:
${headlines.map(h => `- ${h}`).join('\n')}

Sources: ${sources.join(', ')}

Analyze the economic and market implications of this topic. Respond ONLY with valid JSON, no markdown:

{
  "why_it_matters": "2-3 sentence explanation synthesizing what this means economically",
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
