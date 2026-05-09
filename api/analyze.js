export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const { category, timeframe } = req.query;

      const economicKeywords = [
        'economy', 'market', 'stock', 'fed', 'federal reserve', 'rate', 'inflation',
        'gdp', 'trade', 'tariff', 'oil', 'opec', 'recession', 'bank', 'earnings',
        'revenue', 'profit', 'loss', 'investment', 'debt', 'deficit', 'export',
        'import', 'supply chain', 'semiconductor', 'energy', 'dollar', 'bond',
        'treasury', 'wall street', 'nasdaq', 'dow', 'crypto', 'bitcoin',
        'merger', 'acquisition', 'ipo', 'layoff', 'hiring', 'unemployment', 'jobs',
        'housing', 'mortgage', 'retail', 'consumer', 'manufacturing',
        'sanctions', 'crude', 'natural gas', 'agriculture', 'shipping',
        'logistics', 'china', 'europe', 'imf', 'world bank', 'gold', 'silver',
        'copper', 'platinum', 'precious metal', 'commodity', 'futures'
      ];

      const categoryKeywords = {
        'energy': ['oil', 'gas', 'opec', 'crude', 'energy', 'petroleum', 'lng', 'pipeline', 'refinery', 'exxon', 'chevron', 'bp', 'shell'],
        'technology': ['tech', 'ai', 'semiconductor', 'chip', 'nvidia', 'apple', 'microsoft', 'google', 'meta', 'amazon', 'software', 'hardware', 'cloud'],
        'financials': ['bank', 'fed', 'federal reserve', 'interest rate', 'inflation', 'treasury', 'bond', 'yield', 'lending', 'credit', 'jpmorgan', 'goldman'],
        'precious-metals': ['gold', 'silver', 'platinum', 'palladium', 'copper', 'precious metal', 'bullion', 'mining', 'commodity'],
        'real-estate': ['housing', 'mortgage', 'real estate', 'reit', 'property', 'home price', 'construction', 'rent'],
        'crypto': ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'defi', 'nft', 'coinbase', 'binance', 'digital currency'],
        'macro': ['gdp', 'recession', 'inflation', 'unemployment', 'jobs', 'fed', 'central bank', 'trade war', 'tariff', 'deficit', 'imf', 'world bank'],
        'consumer': ['retail', 'consumer', 'spending', 'walmart', 'amazon', 'target', 'sales', 'e-commerce', 'luxury'],
        'healthcare': ['pharma', 'drug', 'fda', 'healthcare', 'biotech', 'clinical', 'medicare', 'insurance', 'pfizer', 'johnson'],
        'defense': ['defense', 'military', 'lockheed', 'boeing', 'raytheon', 'northrop', 'weapons', 'pentagon', 'nato']
      };

      const indianSources = ['livemint', 'mint', 'economic times', 'moneycontrol', 'business standard', 'ndtv', 'hindustan times', 'times of india', 'the hindu', 'financial express', 'free press journal', 'the week'];
      const indianKeywords = ['nse', 'bse', 'sensex', 'nifty', 'rupee', 'crore', 'lakh', 'sebi', 'rbi', 'swiggy', 'zomato'];

      // Build timeframe filter
      let fromDate = '';
      const now = new Date();
      if (timeframe === '3days') {
        const d = new Date(now); d.setDate(d.getDate() - 3);
        fromDate = d.toISOString().split('T')[0];
      } else if (timeframe === '7days') {
        const d = new Date(now); d.setDate(d.getDate() - 7);
        fromDate = d.toISOString().split('T')[0];
      } else {
        // Default: today
        fromDate = now.toISOString().split('T')[0];
      }

      let articles = [];

      // Fetch GNews
      try {
        const query = category && category !== 'any' && categoryKeywords[category]
          ? categoryKeywords[category].slice(0, 5).join(' OR ')
          : 'economy OR "interest rates" OR "federal reserve" OR inflation OR tariffs OR "trade policy" OR OPEC OR "oil prices" OR recession OR "central bank" OR "earnings report" OR GDP OR "stock market"';

        const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=50&sortby=publishedAt&from=${fromDate}&apikey=${process.env.GNEWS_KEY}`;
        const gnewsRes = await fetch(url);
        const gnewsData = await gnewsRes.json();
        if (gnewsData.articles && Array.isArray(gnewsData.articles)) {
          gnewsData.articles.forEach(a => {
            articles.push({
              title: a.title,
              source: a.source && a.source.name ? a.source.name : 'Unknown',
              date: a.publishedAt
            });
          });
        }
      } catch (e) {}

      if (articles.length === 0) {
        return res.status(200).json({ groups: [] });
      }

      // Filter
      const filtered = articles.filter(a => {
        const title = a.title.toLowerCase();
        const source = a.source.toLowerCase();
        const hasKeyword = economicKeywords.some(k => title.includes(k));
        const isIndianSource = indianSources.some(s => source.includes(s));
        const hasIndianKeyword = indianKeywords.some(k => title.includes(k));
        const passesCategory = !category || category === 'any' || !categoryKeywords[category] ||
          categoryKeywords[category].some(k => title.includes(k.toLowerCase()));
        return hasKeyword && !isIndianSource && !hasIndianKeyword && passesCategory;
      });

      // Deduplicate
      const seen = new Set();
      const deduped = filtered.filter(a => {
        const key = a.title.substring(0, 50).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (deduped.length === 0) {
        return res.status(200).json({ groups: [] });
      }

      // Group with Claude
      const groupPrompt = `You are a news editor. Here are ${deduped.length} news headlines. Group them by topic. Give each group a clear concise title (max 10 words).

Headlines:
${deduped.map((a, i) => `${i + 1}. "${a.title}" — ${a.source}`).join('\n')}

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
- Only economic/market relevant groups
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
        const groupArticles = g.indices.map(i => deduped[i - 1]).filter(Boolean);
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
  "impact_timeframe": "Brief note on when this impact is likely to materialize (e.g. 'Immediate to 2 weeks', 'Over the next 1-3 months')",
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