export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const { category, timeframe } = req.query;

      const categoryQueries = {
        'any':            ['stock market economy', 'federal reserve inflation', 'earnings GDP trade', 'oil prices OPEC', 'tech stocks AI', 'bond yields treasury', 'recession unemployment jobs', 'merger acquisition IPO', 'tariffs trade war', 'crypto bitcoin'],
        'macro':          ['federal reserve interest rates', 'inflation CPI GDP', 'recession unemployment', 'treasury yields bonds', 'central bank policy'],
        'energy':         ['oil prices OPEC crude', 'natural gas energy sector', 'petroleum refinery LNG', 'energy stocks earnings', 'oil supply demand'],
        'technology':     ['AI stocks nvidia semiconductor', 'tech earnings apple microsoft', 'google meta amazon earnings', 'chip shortage technology', 'software cloud AI'],
        'financials':     ['federal reserve bank earnings', 'interest rates JPMorgan Goldman', 'treasury yields credit', 'banking sector financial', 'lending mortgage rates'],
        'precious-metals':['gold price silver', 'precious metals mining', 'gold ETF bullion', 'copper platinum commodity', 'gold market'],
        'real-estate':    ['housing market mortgage rates', 'real estate home prices', 'REIT property market', 'construction housing starts', 'mortgage lending'],
        'crypto':         ['bitcoin ethereum crypto', 'cryptocurrency market blockchain', 'coinbase crypto regulation', 'digital assets defi', 'bitcoin price'],
        'consumer':       ['retail sales consumer spending', 'walmart amazon target earnings', 'consumer confidence retail', 'e-commerce spending', 'consumer prices inflation'],
        'healthcare':     ['pharma FDA drug approval', 'healthcare biotech earnings', 'medicare drug prices', 'clinical trial biotech', 'health insurance pharma'],
        'defense':        ['defense stocks military spending', 'lockheed boeing raytheon', 'NATO defense budget', 'weapons contracts pentagon', 'geopolitical defense']
      };

      const queries = categoryQueries[category] || categoryQueries['any'];

      const indianKeywords = ['nse', 'bse', 'sensex', 'nifty', 'rupee', 'crore', 'lakh', 'sebi', 'rbi', 'swiggy', 'zomato'];

      // Fetch many RSS feeds in parallel
      const rssUrls = queries.map(q =>
        `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
      );

      const rssResults = await Promise.allSettled(rssUrls.map(url => fetch(url)));

      let rawItems = [];

      for (const result of rssResults) {
        if (result.status === 'fulfilled') {
          try {
            const text = await result.value.text();
            const itemMatches = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
            for (const match of itemMatches) {
              const item = match[1];
              const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
              const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
              const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
              const linkMatch = item.match(/<link>(.*?)<\/link>/);

              if (titleMatch) {
                const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
                const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : 'Unknown';
                const pubDate = pubDateMatch ? pubDateMatch[1] : '';
                const link = linkMatch ? linkMatch[1] : '';

                if (title.length > 15) {
                  rawItems.push({ title, source, date: pubDate, link });
                }
              }
            }
          } catch(e) {}
        }
      }

      // Timeframe filter
      if (timeframe && timeframe !== 'any') {
        rawItems = rawItems.filter(a => {
          if (!a.date) return true;
          const articleDate = new Date(a.date);
          const now = new Date();
          const daysDiff = (now - articleDate) / (1000 * 60 * 60 * 24);
          if (timeframe === 'today' && daysDiff > 2) return false;
          if (timeframe === '3days' && daysDiff > 3) return false;
          if (timeframe === '7days' && daysDiff > 7) return false;
          return true;
        });
      }

      // Filter out Indian content
      rawItems = rawItems.filter(a => {
        const titleLower = a.title.toLowerCase();
        return !indianKeywords.some(k => titleLower.includes(k));
      });

      // Deduplicate by title similarity
      const seen = new Set();
      const deduped = rawItems.filter(a => {
        const key = a.title.substring(0, 60).toLowerCase().replace(/[^a-z0-9 ]/g, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (deduped.length === 0) {
        return res.status(200).json({ groups: [] });
      }

      // Limit to 80 for grouping
      const limited = deduped.slice(0, 80);

      // Group with Claude — strict instructions
      const groupPrompt = `You are a senior financial news editor at The Economist. Here are ${limited.length} headlines. Your job is to group them into distinct, specific market events.

Headlines:
${limited.map((a, i) => `${i + 1}. "${a.title}" — ${a.source}`).join('\n')}

STRICT RULES:
1. Merge ALL headlines about the same specific event into ONE group (e.g. all mortgage rate stories = one group)
2. Topics must be SPECIFIC events or developments, not general trends. Bad: "Mortgage Rate Trends". Good: "30-Year Mortgage Rates Hit 7.2% as Fed Signals Delay"
3. If a topic covers a specific company, name it in the title (e.g. "Apple Faces EU Antitrust Fine Over App Store")
4. Do NOT create separate groups for slight variations of the same story
5. Only include groups with genuine market-moving significance
6. Aim for 6-10 highly distinct, specific groups
7. Maximum 10 groups
8. Each index appears in exactly one group
9. Ignore non-economic stories entirely

Respond ONLY with valid JSON, no markdown:
{
  "groups": [
    {
      "topic": "Specific descriptive topic title",
      "indices": [1, 3, 5, 7, 12, 18]
    }
  ]
}`;

      const groupRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
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
  const prompt = `You are a senior financial analyst focused exclusively on US markets. Multiple news outlets are reporting on this specific market event:

Topic: "${topic}"

Headlines from ${sources.length} sources:
${headlines.map(h => `- ${h}`).join('\n')}

Analyze the economic and market implications with the precision of a Goldman Sachs research note. Focus on the SPECIFIC event described, not general trends. The user wants to understand the impact over: ${impactTimeframe || '1 month'}.

CRITICAL RULES:
- Beneficiaries and losers must ONLY reference stocks, ETFs, or bonds traded on US exchanges (NYSE, NASDAQ, CBOE)
- No foreign-listed stocks (no .NS, .TO, .L, .DE, .HK suffixes)
- If the event affects a foreign company that also trades as an ADR in the US, you may include the US ADR ticker
- Sectors should reflect US market sectors only

Respond ONLY with valid JSON, no markdown:

{
  "why_it_matters": "2-3 sentences explaining the SPECIFIC economic significance of this event, with concrete numbers or mechanisms where possible",
  "impact_timeframe": "Specific timeframe when this impact materializes (e.g. 'Immediate — within 48 hours', 'Over the next 2-4 weeks')",
  "sectors": {
    "positive": ["specific US sector 1", "specific US sector 2"],
    "negative": ["specific US sector 3"],
    "neutral": []
  },
  "winners": {
    "explanation": "1-2 sentences on WHY these specific US-listed companies or ETFs benefit from THIS specific event",
    "tickers": ["TICK1", "TICK2", "TICK3"]
  },
  "losers": {
    "explanation": "1-2 sentences on WHY these specific US-listed companies or ETFs are hurt by THIS specific event",
    "tickers": ["TICK4", "TICK5"]
  },
  "confidence": "High/Medium/Low — specific reason tied to this event"
}`;

Topic: "${topic}"

Headlines from ${sources.length} sources:
${headlines.map(h => `- ${h}`).join('\n')}

Analyze the economic and market implications with the precision of a Goldman Sachs research note. Focus on the SPECIFIC event described, not general trends. The user wants to understand the impact over: ${impactTimeframe || '1 month'}.

Respond ONLY with valid JSON, no markdown:

{
  "why_it_matters": "2-3 sentences explaining the SPECIFIC economic significance of this event, with concrete numbers or mechanisms where possible",
  "impact_timeframe": "Specific timeframe when this impact materializes (e.g. 'Immediate — within 48 hours', 'Over the next 2-4 weeks')",
  "sectors": {
    "positive": ["specific sector 1", "specific sector 2"],
    "negative": ["specific sector 3"],
    "neutral": []
  },
  "winners": {
    "explanation": "1-2 sentences on WHY these specific companies benefit from THIS specific event",
    "tickers": ["TICK1", "TICK2", "TICK3"]
  },
  "losers": {
    "explanation": "1-2 sentences on WHY these specific companies are hurt by THIS specific event",
    "tickers": ["TICK4", "TICK5"]
  },
  "confidence": "High/Medium/Low — specific reason tied to this event"
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