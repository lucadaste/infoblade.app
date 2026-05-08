export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
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

      // Fetch from both sources in parallel
      const [gnewsRes, newsdataRes] = await Promise.allSettled([
        fetch(`https://gnews.io/api/v4/search?q=economy OR "interest rates" OR "federal reserve" OR inflation OR tariffs OR "trade policy" OR OPEC OR "oil prices" OR recession OR "central bank" OR "earnings report" OR GDP OR "stock market"&lang=en&max=30&sortby=publishedAt&apikey=${process.env.GNEWS_KEY}`),
        fetch(`https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_KEY}&q=economy OR inflation OR "stock market" OR "federal reserve" OR tariffs OR GDP OR earnings&language=en&category=business`)
      ]);

      let articles = [];

      // Process GNews
      if (gnewsRes.status === 'fulfilled') {
        const gnewsData = await gnewsRes.value.json();
        if (gnewsData.articles) {
          const gnews = gnewsData.articles.map(a => ({
            title: a.title,
            source: a.source?.name || 'Unknown',
            date: a.publishedAt
          }));
          articles = articles.concat(gnews);
        }
      }

      // Process NewsData
      console.log('NewsData response:', JSON.stringify(newsdataData).substring(0, 500));
if (newsdataData.results && Array.isArray(newsdataData.results)) {
  const newsdata = newsdataData.results.map(a => ({
    title: a.title,
    source: a.source_id || 'Unknown',
    date: a.pubDate
  }));
  articles = articles.concat(newsdata);
}
      }

      if (articles.length === 0) {
  return res.status(500).json({ error: 'No articles from either source', debug: 'Both APIs returned empty' });
}

      // Filter to economic articles only
      const filtered = articles.filter(a => {
        const title = a.title.toLowerCase();
        return economicKeywords.some(k => title.includes(k));
      });

      // Deduplicate by similar titles
      const seen = new Set();
      const deduped = filtered.filter(a => {
        const key = a.title.substring(0, 50).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const groupPrompt = `You are a news editor. Here are ${deduped.length} news headlines from multiple sources. Group them by topic — headlines covering the same event or story should be in the same group. Give each group a clear, concise topic title (max 10 words).

Headlines:
${deduped.map((a, i) => `${i + 1}. "${a.title}" — ${a.source}`).join('\n')}

Respond ONLY with valid JSON, no markdown:
{
  "groups": [
    {
      "topic": "Short topic title summarizing the theme",
      "indices": [1, 3, 5]
    }
  ]
}

Rules:
- Each index appears in exactly one group
- Only include groups with genuine economic/market relevance
- Ignore non-economic stories entirely
- Maximum 6 groups
- indices are 1-based`;

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

      const groups = grouped.groups.map(g => {
        const groupArticles = g.indices.map(i => deduped[i - 1]).filter(Boolean);
        const uniqueSources = [...new Set(groupArticles.map(a => a.source))];
        return {
          topic: g.topic,
          sources: uniqueSources,
          totalSources: uniqueSources.length,
          headlines: groupArticles.map(a => a.title),
          dates: groupArticles.map(a => a.date)
        };
      });

      return res.status(200).json({ groups });

    } catch (err) {
  return res.status(500).json({ error: err.message, stack: err.stack });
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
