export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const { category, timeframe } = req.query;

      const categoryQueries = {
        'any':            'stock market OR economy OR inflation OR federal reserve OR GDP OR earnings OR tariffs OR recession',
        'macro':          'federal reserve OR inflation OR GDP OR recession OR interest rates OR unemployment OR central bank',
        'energy':         'oil prices OR OPEC OR crude oil OR natural gas OR energy sector OR petroleum OR LNG',
        'technology':     'AI stocks OR semiconductor OR nvidia OR tech earnings OR apple OR microsoft OR google',
        'financials':     'federal reserve OR bank earnings OR interest rates OR JPMorgan OR Goldman Sachs OR treasury yields',
        'precious-metals':'gold price OR silver price OR precious metals OR gold ETF OR mining stocks',
        'real-estate':    'housing market OR mortgage rates OR real estate OR home prices OR REIT',
        'crypto':         'bitcoin OR ethereum OR crypto market OR cryptocurrency OR coinbase OR blockchain',
        'consumer':       'retail sales OR consumer spending OR walmart OR amazon earnings OR consumer confidence',
        'healthcare':     'pharma stocks OR FDA approval OR healthcare earnings OR biotech OR drug prices',
        'defense':        'defense stocks OR military spending OR lockheed OR raytheon OR boeing defense OR geopolitical'
      };

      const query = categoryQueries[category] || categoryQueries['any'];

      // Fetch from multiple Google News RSS feeds in parallel
      const rssUrls = [
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
        `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' market')}&hl=en-US&gl=US&ceid=US:en`,
        `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' stocks')}&hl=en-US&gl=US&ceid=US:en`
      ];

      const rssResults = await Promise.allSettled(rssUrls.map(url => fetch(url)));
      let rawXml = '';

      for (const result of rssResults) {
        if (result.status === 'fulfilled') {
          const text = await result.value.text();
          rawXml += text;
        }
      }

      // Parse RSS XML
      const itemMatches = rawXml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      const articles = [];
      const seen = new Set();

      for (const match of itemMatches) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
        const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/) || item.match(/- (.*?)$/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

        if (titleMatch) {
          const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
          const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : 'Google News';
          const pubDate = pubDateMatch ? pubDateMatch[1] : '';

          // Deduplicate
          const key = title.substring(0, 60).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          // Timeframe filter
          if (timeframe && timeframe !== 'any' && pubDate) {
            const articleDate = new Date(pubDate);
            const now = new Date();
            const daysDiff = (now - articleDate) / (1000 * 60 * 60 * 24);
            if (timeframe === 'today' && daysDiff > 2) continue;
            if (timeframe === '3days' && daysDiff > 3) continue;
            if (timeframe === '7days' && daysDiff > 7) continue;
          }

          // Filter out non-English and Indian content
          const indianKeywords = ['nse', 'bse', 'sensex', 'nifty', 'rupee', 'crore', 'lakh', 'sebi', 'rbi', 'swiggy', 'zomato'];
          const titleLower = title.toLowerCase();
          const isIndian = indianKeywords.some(k => titleLower.includes(k));
          if (isIndian) continue;

          if (title.length > 10) {
            articles.push({ title, source, date: pubDate });
          }
        }
      }

      if (articles.length === 0) {
        return res.status(200).json({ groups: [] });
      }

      // Limit to 60 most recent for grouping
      const limited = articles.slice(0, 60);

      // Group with Claude
      const groupPrompt = `You are a financial news editor. Here are ${limited.length} headlines. Group them by topic — headlines covering the same event should be in one group. Give each group a clear concise title (max 10 words).

Headlines:
${limited.map((a, i) => `${i + 1}. "${a.title}" — ${a.source}`).join('\n')}

Respond ONLY with valid JSON, no markdown:
{
  "groups": [
    {
      "topic": "Short topic title",
      "indices": [1, 3, 5]
    }
  ]
}

Rules:
- Each index in exactly one group
- Only include groups with genuine economic/market relevance
- Ignore sports, entertainment, crime, personal stories
- Aim for 8-10 groups if enough articles support it
- Maximum 10 groups
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
          max_tokens: 1500,
          messages: [{ role: 'user', content: groupPrompt }]
        })
      });

      const groupData = await groupRes.json();
      const groupRaw = groupData.content[0].text.replace(/```json|```/g, '').trim();
      const grouped = JSON.parse(groupRaw);

      const groups = grouped.groups.map(g => {
        const groupArticles = g.indices.map(i => limited[i - 1]).filter(Boolean);
        const uniqueSources = [...new Set(groupArticles.map(a => a.source))];
        return {
          topic: g.topic,
          sources: uniqueSources,
          totalSources: groupArticles.length,
          headlines: groupArticles.map(a => a.title),
          dates: groupArticles.map(a => a.date)
        };
      });

      return res.status(200).json({ groups });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { topic, headlines, sources, impactTimeframe } = req.body;

    if (!topic) return res.status(400).json({ error: 'No topic provided' });

    try {
      const prompt = `You are a financial analyst AI. Multiple news outlets are reporting on this market topic:

Topic: "${topic}"

Headlines:
${headlines.map(h => `- ${h}`).join('\n')}

Sources: ${sources.join(', ')}

Analyze the economic and market implications. The user wants to understand the impact over: ${impactTimeframe || '1 month'}.

Respond ONLY with valid JSON, no markdown:

{
  "why_it_matters": "2-3 sentence explanation synthesizing what this means economically",
  "impact_timeframe": "Brief note on when this impact is likely to materialize",
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