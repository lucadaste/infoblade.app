import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const _reputationPath = path.resolve(_dir, '../data/source-reputation.json');
const _predictionPath = path.resolve(_dir, '../data/prediction-log.json');

async function _readReputation() {
  try {
    return JSON.parse(await fs.readFile(_reputationPath, 'utf-8') || '{}');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function _parseTimeframeDays(str) {
  if (!str) return 30;
  const s = str.toLowerCase();
  if (s.includes('48 hour') || (s.includes('2') && s.includes('day'))) return 2;
  if (s.includes('week')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*week/);
    if (range) return Math.round((+range[1] + +range[2]) / 2) * 7;
    const single = s.match(/(\d+)\s*week/);
    return single ? +single[1] * 7 : 14;
  }
  if (s.includes('month')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*month/);
    if (range) return Math.round((+range[1] + +range[2]) / 2) * 30;
    const single = s.match(/(\d+)\s*month/);
    return single ? +single[1] * 30 : 30;
  }
  return 30;
}

const _PM_STOPWORDS = new Set([
  'will','does','when','what','this','that','with','from','have','been','would','could','should',
  'which','their','there','about','after','before','during','between','against','into','over',
  'under','than','more','most','least','just','still','also','ever','even','only','much','many'
]);

async function _fetchRelevantMarkets(topic) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const url = 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200&order=volume24hr&ascending=false';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timer);
    const events = await res.json();

    const topicWords = topic.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !_PM_STOPWORDS.has(w));

    const relevant = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (!event.active || event.closed || event.archived) continue;
      const title = (event.title || '').toLowerCase();
      const matchCount = topicWords.filter(w => title.includes(w)).length;
      if (matchCount < 2) continue;

      const ms = event.markets || [];
      const primary = ms.length === 1
        ? ms[0]
        : [...ms].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];
      if (!primary) continue;

      let yesPrice = null;
      try {
        const prices = typeof primary.outcomePrices === 'string'
          ? JSON.parse(primary.outcomePrices) : primary.outcomePrices;
        yesPrice = Math.round(parseFloat(prices[0]) * 100);
      } catch (_) { continue; }
      if (yesPrice === null || yesPrice < 1 || yesPrice > 99) continue;

      relevant.push({
        question: primary.question || event.title,
        yesPrice,
        volume24h: Math.round(parseFloat(event.volume24hr || 0)),
        matchCount
      });
    }

    return relevant
      .sort((a, b) => b.matchCount - a.matchCount || b.volume24h - a.volume24h)
      .slice(0, 4);
  } catch (_) {
    return [];
  }
}

async function _fetchPrices(tickers) {
  if (!tickers || !tickers.length) return {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    const prices = {};
    for (const q of data?.quoteResponse?.result || []) {
      if (q.regularMarketPrice) prices[q.symbol] = q.regularMarketPrice;
    }
    return prices;
  } catch (_) { return {}; }
}

async function _savePrediction(record) {
  try {
    let entries = [];
    try { entries = JSON.parse(await fs.readFile(_predictionPath, 'utf-8') || '[]'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    entries.push(record);
    await fs.mkdir(path.dirname(_predictionPath), { recursive: true });
    await fs.writeFile(_predictionPath, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sourceQualityMap = {
    'Reuters': 'High',
    'Associated Press': 'High',
    'Bloomberg': 'High',
    'Financial Times': 'High',
    'The Wall Street Journal': 'High',
    'The Economist': 'High',
    'BBC': 'High',
    'NPR': 'High',
    'CNBC': 'High',
    'Wall Street Journal': 'High',
    'Financial Times': 'High',
    'AP': 'High',
    'Politico': 'Medium',
    'Business Insider': 'Medium',
    'MarketWatch': 'Medium',
    'Yahoo Finance': 'Medium',
    'CNN': 'Medium',
    'The Guardian': 'Medium',
    'NBC News': 'Medium',
    'CBS News': 'Medium',
    'Fox Business': 'Medium',
    'Forbes': 'Medium',
    'Quartz': 'Medium',
    'Axios': 'Medium',
    'Bloomberg Opinion': 'Medium',
    'Fox News': 'Low',
    'Breitbart': 'Low',
    'ZeroHedge': 'Low',
    'Daily Mail': 'Low',
    'New York Post': 'Low',
    'The Daily Caller': 'Low',
    'Infowars': 'Low',
    'The Blaze': 'Low'
  };

  const gradeScores = { high: 3, medium: 2, low: 1, unknown: 0 };

  function normalizeSourceName(source) {
    return source
      .replace(/\s*\(.*?\)/g, '')
      .replace(/[“”‘’]/g, '')
      .replace(/\b(news|tv|online|magazine|channel)\b/gi, '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getSourceGrade(source) {
    const normalized = normalizeSourceName(source);
    for (const sourceKey of Object.keys(sourceQualityMap)) {
      if (normalized.includes(sourceKey.toLowerCase())) return sourceQualityMap[sourceKey];
    }
    return 'Unknown';
  }

  const gradeWeights = { High: 1.0, Medium: 0.7, Low: 0.4, Unknown: 0.2 };

  function getEffectiveWeight(source, grade, reputation) {
    const base = gradeWeights[grade] ?? 0.2;
    const stats = reputation[source];
    if (!stats || stats.attempts < 30) return base;
    const accuracy = stats.correct / stats.attempts;
    const ramp = Math.min((stats.attempts - 30) / 30, 1.0);
    const multiplier = Math.max(0.5, Math.min(1.5, 0.4 + accuracy));
    return base * (1.0 + (multiplier - 1.0) * ramp);
  }

  const STOPWORDS = new Set([
    'the','and','for','with','that','this','from','after','over','under','into','between','about','before',
    'are','was','were','will','have','has','had','not','but','when','where','which','their','they','them','its','also',
    'more','than','same','new','market','industry','companies','company','stock','stocks','price','prices',
    'rise','fall','up','down','higher','lower','gain','gains','loss','losses','on','in','of','to','a','an','as','is'
  ]);

  function tokenizeHeadline(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !STOPWORDS.has(word));
  }

  function weightedTokenCounts(items, reputation = {}) {
    const counts = {};
    items.forEach(({ headline, grade, source }) => {
      const weight = getEffectiveWeight(source || '', grade, reputation);
      const tokens = tokenizeHeadline(headline);
      const seen = new Set(tokens);
      seen.forEach(token => {
        counts[token] = (counts[token] || 0) + weight;
      });
    });
    return counts;
  }

  function topTokens(counts, limit = 5) {
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([token]) => token);
  }

  function buildConsensusSummary({ headlines, sources, sourceGrades, minGrade, reputation = {} }) {
    const minScore = gradeScores[minGrade] ?? gradeScores.medium;
    const records = sources.map((source, idx) => ({
      source,
      headline: headlines[idx] || '',
      grade: sourceGrades?.[source] || getSourceGrade(source)
    }));

    const passing = records.filter(r => gradeScores[r.grade.toLowerCase()] >= minScore);
    const high = passing.filter(r => r.grade === 'High');
    const medium = passing.filter(r => r.grade === 'Medium');

    const overall = topTokens(weightedTokenCounts(passing, reputation));
    const highTop = topTokens(weightedTokenCounts(high, reputation));
    const mediumTop = topTokens(weightedTokenCounts(medium, reputation));

    const pieces = [];
    if (highTop.length) pieces.push(`High-grade sources focus on ${highTop.join(', ')}`);
    if (mediumTop.length) pieces.push(`Medium-grade sources add emphasis on ${mediumTop.join(', ')}`);
    if (overall.length) pieces.push(`Weighted consensus among passing sources highlights ${overall.join(', ')}`);

    return pieces.length ? pieces.join('. ') + '.' : 'No strong consensus found among passing sources.';
  }

  if (req.method === 'GET') {
    try {
      const { category, timeframe, minGrade } = req.query;
      const selectedGrade = minGrade || 'medium';
      const threshold = gradeScores[selectedGrade] ?? 2;

      const categoryQueries = {
        'any':             ['stock market economy', 'federal reserve inflation', 'earnings GDP trade', 'oil prices OPEC', 'tech stocks AI', 'bond yields treasury', 'recession unemployment jobs', 'merger acquisition IPO', 'tariffs trade war', 'crypto bitcoin'],
        'macro':           ['federal reserve interest rates', 'inflation CPI GDP', 'recession unemployment', 'treasury yields bonds', 'central bank policy'],
        'energy':          ['oil prices OPEC crude', 'natural gas energy sector', 'petroleum refinery LNG', 'energy stocks earnings', 'oil supply demand'],
        'technology':      ['AI stocks nvidia semiconductor', 'tech earnings apple microsoft', 'google meta amazon earnings', 'chip shortage technology', 'software cloud AI'],
        'financials':      ['federal reserve bank earnings', 'interest rates JPMorgan Goldman', 'treasury yields credit', 'banking sector financial', 'lending mortgage rates'],
        'precious-metals': ['gold price silver', 'precious metals mining', 'gold ETF bullion', 'copper platinum commodity', 'gold market'],
        'real-estate':     ['housing market mortgage rates', 'real estate home prices', 'REIT property market', 'construction housing starts', 'mortgage lending'],
        'crypto':          ['bitcoin ethereum crypto', 'cryptocurrency market blockchain', 'coinbase crypto regulation', 'digital assets defi', 'bitcoin price'],
        'consumer':        ['retail sales consumer spending', 'walmart amazon target earnings', 'consumer confidence retail', 'e-commerce spending', 'consumer prices inflation'],
        'healthcare':      ['pharma FDA drug approval', 'healthcare biotech earnings', 'drug pricing pharma stocks', 'clinical trial biotech FDA', 'health insurance UnitedHealth Humana', 'Pfizer Moderna Merck Johnson', 'hospital Medicare Medicaid policy', 'cancer treatment biotech pipeline'],
        'defense':         ['defense stocks military spending', 'lockheed boeing raytheon', 'NATO defense budget', 'weapons contracts pentagon', 'geopolitical defense']
      };

      const queries = categoryQueries[category] || categoryQueries['any'];
      const indianKeywords = ['nse', 'bse', 'sensex', 'nifty', 'rupee', 'crore', 'lakh', 'sebi', 'rbi', 'swiggy', 'zomato'];

      // Direct outlet RSS feeds (category-specific + base)
      const BASE_DIRECT_FEEDS = [
        { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters' },
        { url: 'https://feeds.reuters.com/reuters/topNews',      source: 'Reuters' },
        { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', source: 'CNBC' },
        { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC' },
        { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch' },
        { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',         source: 'The Wall Street Journal' },
        { url: 'https://www.economist.com/finance-and-economics/rss.xml', source: 'The Economist' },
        { url: 'https://feeds.npr.org/1017/rss.xml',                     source: 'NPR' },
      ];
      const CATEGORY_DIRECT_FEEDS = {
        technology:      [{ url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html', source: 'CNBC' }],
        energy:          [{ url: 'https://feeds.reuters.com/reuters/energy',              source: 'Reuters' }],
        healthcare:      [
          { url: 'https://feeds.reuters.com/reuters/health',                              source: 'Reuters' },
          { url: 'https://www.cnbc.com/id/10000108/device/rss/rss.html',                  source: 'CNBC' },
        ],
        crypto:          [{ url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',       source: 'CoinDesk' }],
      };
      const directFeeds = [...BASE_DIRECT_FEEDS, ...(CATEGORY_DIRECT_FEEDS[category] || [])];

      // Google News RSS feeds
      const googleUrls = queries.map(q =>
        `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
      );

      function fetchWithTimeout(url, timeoutMs) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      }

      function parseRssItems(text, fallbackSource) {
        const items = [];
        const itemMatches = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        for (const match of itemMatches) {
          const item = match[1];
          const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
          const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
          const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
          if (titleMatch) {
            const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
            const source = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : fallbackSource;
            const pubDate = pubDateMatch ? pubDateMatch[1] : '';
            if (title.length > 15) items.push({ title, source, date: pubDate });
          }
        }
        return items;
      }

      const [googleResults, directResults] = await Promise.all([
        Promise.allSettled(googleUrls.map(url => fetchWithTimeout(url, 8000))),
        Promise.allSettled(directFeeds.map(f => fetchWithTimeout(f.url, 5000).then(r => ({ res: r, source: f.source }))))
      ]);

      let rawItems = [];

      for (const result of googleResults) {
        if (result.status === 'fulfilled') {
          try {
            const text = await result.value.text();
            for (const item of parseRssItems(text, 'Unknown')) {
              rawItems.push({ ...item, grade: getSourceGrade(item.source) });
            }
          } catch(e) {}
        }
      }

      for (const result of directResults) {
        if (result.status === 'fulfilled') {
          try {
            const { res, source } = result.value;
            const text = await res.text();
            for (const item of parseRssItems(text, source)) {
              rawItems.push({ ...item, grade: getSourceGrade(item.source) });
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

      // Filter Indian content
      rawItems = rawItems.filter(a => {
        const t = a.title.toLowerCase();
        return !indianKeywords.some(k => t.includes(k));
      });

      if (selectedGrade !== 'all') {
        rawItems = rawItems.filter(a => gradeScores[a.grade.toLowerCase()] >= threshold);
      }

      const seen = new Set();
      const deduped = rawItems.filter(a => {
        const key = a.title.toLowerCase()
          .replace(/[^a-z0-9 ]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .filter(w => w.length > 2)
          .slice(0, 8)
          .join(' ');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (deduped.length === 0) {
        return res.status(200).json({ groups: [] });
      }

      const categoryLabels = {
        'any': 'general financial markets', 'macro': 'macroeconomics and monetary policy',
        'technology': 'technology sector', 'energy': 'energy sector', 'financials': 'financial sector',
        'precious-metals': 'precious metals and commodities', 'real-estate': 'real estate and housing',
        'crypto': 'cryptocurrency and blockchain', 'consumer': 'consumer spending and retail',
        'healthcare': 'healthcare, pharmaceutical, and biotech sectors', 'defense': 'defense and aerospace sector'
      };
      const categoryLabel = categoryLabels[category] || 'financial markets';

      // Group ALL articles — no limit
      const groupPrompt = `You are a senior financial news editor at The Economist specializing in ${categoryLabel}. Here are ${deduped.length} headlines. Group them into distinct specific market events RELEVANT TO ${categoryLabel.toUpperCase()}.

Headlines:
${deduped.map((a, i) => `${i + 1}. "${a.title}" — ${a.source}`).join('\n')}

STRICT RULES:
1. ONLY create groups about ${categoryLabel} — skip headlines unrelated to this sector
2. Merge ALL headlines about the same specific event into ONE group — be aggressive about merging
3. Topics must be SPECIFIC events not general trends
4. If a topic covers a specific company name it in the title
5. Do NOT create separate groups for variations of the same story
6. Only groups with genuine market-moving significance
7. Aim for 10-15 highly distinct specific groups
8. Maximum 15 groups
9. Each index appears in exactly one group
10. Include ALL relevant indices in each group — do not leave articles ungrouped if they belong to a topic

Respond ONLY with valid JSON, no markdown:
{"groups":[{"topic":"Specific descriptive title","indices":[1,3,5,7,12,18,24,31]}]}`;

      const groupRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 6000,
          messages: [{ role: 'user', content: groupPrompt }]
        })
      });

      const groupData = await groupRes.json();
      if (groupData.error) return res.status(500).json({ error: groupData.error.message });

      const groupRaw = groupData.content[0].text.replace(/```json|```/g, '').trim();
      const grouped = JSON.parse(groupRaw);

      const groups = grouped.groups.map(g => {
        const groupArticles = g.indices.map(i => deduped[i - 1]).filter(Boolean);
        const uniqueSources = [...new Set(groupArticles.map(a => a.source))];
        const sourceGrades = {};
        uniqueSources.forEach(source => {
          sourceGrades[source] = getSourceGrade(source);
        });
        return {
          topic: g.topic,
          sources: uniqueSources,
          sourceGrades,
          minGrade: selectedGrade,
          totalSources: groupArticles.length,
          headlines: groupArticles.map(a => a.title),
          dates: groupArticles.map(a => a.date)
        };
      });

      // Sort by relevance
      const sortPrompt = `Rank these market topics by how likely they are to actually move US stock prices today, from most to least impactful.

Topics:
${groups.map((g, i) => `${i + 1}. ${g.topic} (${g.totalSources} sources)`).join('\n')}

Respond ONLY with valid JSON, no markdown:
{"ranked":[2,1,4,3,5]}`;

      try {
        const sortRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 200,
            messages: [{ role: 'user', content: sortPrompt }]
          })
        });

        const sortData = await sortRes.json();
        const sortRaw = sortData.content[0].text.replace(/```json|```/g, '').trim();
        const sorted = JSON.parse(sortRaw);
        const rankedGroups = sorted.ranked.map(i => groups[i - 1]).filter(Boolean);
        return res.status(200).json({ groups: rankedGroups });
      } catch(e) {
        return res.status(200).json({ groups });
      }

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { topic, headlines, sources, sourceGrades = {}, minGrade = 'medium', impactTimeframe } = req.body;

    if (!topic) return res.status(400).json({ error: 'No topic provided' });

    try {
      const [reputation, relevantMarkets] = await Promise.all([
        _readReputation(),
        _fetchRelevantMarkets(topic)
      ]);
      const thresholdText = minGrade === 'all' ? 'all provided sources' : `sources with factuality grade ${minGrade.charAt(0).toUpperCase() + minGrade.slice(1)} or higher`;
      const consensus = buildConsensusSummary({ headlines, sources, sourceGrades, minGrade, reputation });

      const reputationLines = (sources || [])
        .filter(s => reputation[s] && reputation[s].attempts >= 30)
        .map(s => {
          const { attempts, correct } = reputation[s];
          const pct = (correct / attempts * 100).toFixed(0);
          const w = getEffectiveWeight(s, sourceGrades?.[s] || 'Unknown', reputation).toFixed(2);
          return `- ${s}: ${pct}% accurate over ${attempts} predictions → effective weight ${w}`;
        });
      const reputationSection = reputationLines.length
        ? `\nHistorical accuracy (reputation-adjusted weights):\n${reputationLines.join('\n')}\n`
        : '';

      const marketsSection = relevantMarkets.length
        ? `\nRelated prediction market odds (Polymarket, live):\n${relevantMarkets.map(m => `- "${m.question}": ${m.yesPrice}% YES ($${Math.round(m.volume24h / 1000)}K 24h vol)`).join('\n')}\nThese represent crowd consensus on related outcomes — use them to calibrate your confidence and assess whether the market has already priced in the event.\n`
        : '';

      const prompt = `You are a senior financial analyst focused exclusively on US markets. Multiple news outlets are reporting on this specific market event:

Topic: "${topic}"

Headlines from ${sources.length} sources:
${headlines.map(h => `- ${h}`).join('\n')}

Sources and factuality grades:
${sources.map(name => `- ${name}: ${sourceGrades?.[name] || 'Unknown'}`).join('\n')}

Use weighted source consensus to shape the prediction:
- High-grade sources carry weight 1.0
- Medium-grade sources carry weight 0.7
- Low-grade sources carry weight 0.4
Only include sources that meet the selected factuality threshold for the final prediction.
${reputationSection}
Consensus summary: ${consensus}
${marketsSection}
Only use ${thresholdText} for this analysis. Do not incorporate details from sources below the selected factuality threshold.

Analyze with the precision of a Goldman Sachs research note. Focus on the SPECIFIC event, not general trends. Impact timeframe: ${impactTimeframe || '1 month'}.

CRITICAL RULES:
- Beneficiaries and losers must ONLY reference stocks ETFs or bonds traded on US exchanges (NYSE NASDAQ CBOE)
- No foreign-listed stocks (no .NS .TO .L .DE .HK suffixes)
- Foreign companies that trade as ADRs in the US may use their US ADR ticker
- Sectors should reflect US market sectors only
- Confidence must be a number from 1 to 5 (stars) followed by a dash and a specific reason. 5 = very high confidence, 3 = moderate, 1 = very low. Almost always output 3, 4, or 5. Only output 1 or 2 for genuinely poor signal.

Respond ONLY with valid JSON, no markdown:
{
  "why_it_matters": "2-3 sentences on specific economic significance with concrete numbers where possible",
  "impact_timeframe": "Specific timeframe e.g. Immediate within 48 hours or Over the next 2-4 weeks",
  "sectors": {
    "positive": ["US sector 1", "US sector 2"],
    "negative": ["US sector 3"],
    "neutral": []
  },
  "winners": {
    "explanation": "Why these specific US-listed stocks or ETFs benefit from this specific event",
    "tickers": ["TICK1", "TICK2", "TICK3"]
  },
  "losers": {
    "explanation": "Why these specific US-listed stocks or ETFs are hurt by this specific event",
    "tickers": ["TICK4", "TICK5"]
  },
  "confidence": "4 — specific reason (number 1-5 followed by dash and reason)"
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

      const raw = data.content[0].text.replace(/```json|```/g, '').trim();
      const analysis = JSON.parse(raw);

      const predictionId = `pred_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const winnerTickers = analysis.winners?.tickers || [];
      const loserTickers = analysis.losers?.tickers || [];
      const allTickers = [...new Set([...winnerTickers, ...loserTickers])];
      const baselinePrices = await _fetchPrices(allTickers);
      const timeframeDays = _parseTimeframeDays(analysis.impact_timeframe || impactTimeframe);
      const validationDate = new Date(Date.now() + timeframeDays * 86400000).toISOString();

      await _savePrediction({
        id: predictionId,
        createdAt: new Date().toISOString(),
        topic, headlines, sources, sourceGrades,
        minGrade: minGrade || 'medium',
        impactTimeframe: impactTimeframe || null,
        analysis,
        winnerTickers,
        loserTickers,
        baselinePrices,
        validationDate,
        validationMethod: null,
        actualOutcome: null,
        correct: null,
        notes: null
      });

      return res.status(200).json({ ...analysis, predictionId });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}