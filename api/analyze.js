import { createClient } from '@supabase/supabase-js';

// ── Supabase ──────────────────────────────────────────────────────────────────
function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

// ── Rate limiting (per-IP, 20 req/min for analyze POST, 60 req/min for GET) ──
async function _checkRateLimit(supabase, ip, limit) {
  const now = new Date();
  const windowStart = new Date(now - 60000);
  const key = `${ip}:analyze`;

  const { data, error } = await supabase
    .from('rate_limits')
    .select('count, window_start')
    .eq('key', key)
    .maybeSingle();

  if (error) return true; // fail open rather than blocking valid users

  if (!data || new Date(data.window_start) < windowStart) {
    await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
    return true;
  }

  if (data.count >= limit) return false;

  await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('key', key);
  return true;
}

// ── Input sanitisation ────────────────────────────────────────────────────────
function _sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, maxLen);
}

function _sanitizeArray(arr, itemMax = 500, listMax = 40) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, listMax).map(s => _sanitize(s, itemMax));
}

function _sanitizeObject(obj, maxKeys = 40, keyMax = 100, valMax = 20) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const result = {};
  for (const [k, v] of Object.entries(obj).slice(0, maxKeys)) {
    result[_sanitize(String(k), keyMax)] = _sanitize(String(v), valMax);
  }
  return result;
}

// ── Timeframe parsing ─────────────────────────────────────────────────────────
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

// ── Polymarket ────────────────────────────────────────────────────────────────
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

      relevant.push({ question: primary.question || event.title, yesPrice, volume24h: Math.round(parseFloat(event.volume24hr || 0)), matchCount });
    }
    return relevant.sort((a, b) => b.matchCount - a.matchCount || b.volume24h - a.volume24h).slice(0, 4);
  } catch (_) { return []; }
}

// ── Yahoo Finance prices ──────────────────────────────────────────────────────
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

// ── Supabase prediction persistence ──────────────────────────────────────────
async function _savePrediction(supabase, record) {
  const { error } = await supabase.from('predictions').insert(record);
  if (error) console.error('Supabase insert error:', error.message);
}

// ── CORS helper ───────────────────────────────────────────────────────────────
function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// ── Crypto Fear & Greed index ─────────────────────────────────────────────────
async function _fetchCryptoFearGreed() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: ctrl.signal });
    clearTimeout(t);
    const d = (await res.json())?.data?.[0];
    return d ? { value: parseInt(d.value), label: d.value_classification } : null;
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sourceQualityMap = {
    'Reuters': 'High', 'Associated Press': 'High', 'Bloomberg': 'High',
    'Financial Times': 'High', 'The Wall Street Journal': 'High', 'The Economist': 'High',
    'BBC': 'High', 'NPR': 'High', 'CNBC': 'High', 'Wall Street Journal': 'High',
    'AP': 'High', 'Politico': 'Medium', 'Business Insider': 'Medium',
    'MarketWatch': 'Medium', 'Yahoo Finance': 'Medium', 'CNN': 'Medium',
    'The Guardian': 'Medium', 'NBC News': 'Medium', 'CBS News': 'Medium',
    'Fox Business': 'Medium', 'Forbes': 'Medium', 'Quartz': 'Medium',
    'Axios': 'Medium', 'Bloomberg Opinion': 'Medium', 'Fox News': 'Low',
    'Breitbart': 'Low', 'ZeroHedge': 'Low', 'Daily Mail': 'Low',
    'New York Post': 'Low', 'The Daily Caller': 'Low', 'Infowars': 'Low', 'The Blaze': 'Low',
    'CoinDesk': 'Medium', 'The Block': 'Medium', 'Decrypt': 'Medium',
    'Cointelegraph': 'Low', 'Forkast': 'Medium', 'CoinPost': 'Medium'
  };
  const gradeScores  = { high: 3, medium: 2, low: 1, unknown: 0 };
  const gradeWeights = { High: 1.0, Medium: 0.7, Low: 0.4, Unknown: 0.2 };

  function normalizeSourceName(source) {
    return source
      .replace(/\s*\(.*?\)/g, '').replace(/[""'']/g, '')
      .replace(/\b(news|tv|online|magazine|channel)\b/gi, '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ').trim().toLowerCase();
  }
  function getSourceGrade(source) {
    const normalized = normalizeSourceName(source);
    for (const key of Object.keys(sourceQualityMap)) {
      if (normalized.includes(key.toLowerCase())) return sourceQualityMap[key];
    }
    return 'Unknown';
  }

  function getEffectiveWeight(source, grade, reputation) {
    const base = gradeWeights[grade] ?? 0.2;
    const stats = reputation?.[source];
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
    return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
  }
  function weightedTokenCounts(items, reputation = {}) {
    const counts = {};
    items.forEach(({ headline, grade, source }) => {
      const weight = getEffectiveWeight(source || '', grade, reputation);
      new Set(tokenizeHeadline(headline)).forEach(token => { counts[token] = (counts[token] || 0) + weight; });
    });
    return counts;
  }
  function topTokens(counts, limit = 5) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
  }
  function buildConsensusSummary({ headlines, sources, sourceGrades, minGrade, reputation = {} }) {
    const minScore = gradeScores[minGrade] ?? gradeScores.medium;
    const records = sources.map((source, idx) => ({ source, headline: headlines[idx] || '', grade: sourceGrades?.[source] || getSourceGrade(source) }));
    const passing = records.filter(r => gradeScores[r.grade.toLowerCase()] >= minScore);
    const high = passing.filter(r => r.grade === 'High');
    const medium = passing.filter(r => r.grade === 'Medium');
    const overall  = topTokens(weightedTokenCounts(passing, reputation));
    const highTop  = topTokens(weightedTokenCounts(high, reputation));
    const medTop   = topTokens(weightedTokenCounts(medium, reputation));
    const pieces = [];
    if (highTop.length)  pieces.push(`High-grade sources focus on ${highTop.join(', ')}`);
    if (medTop.length)   pieces.push(`Medium-grade sources add emphasis on ${medTop.join(', ')}`);
    if (overall.length)  pieces.push(`Weighted consensus among passing sources highlights ${overall.join(', ')}`);
    return pieces.length ? pieces.join('. ') + '.' : 'No strong consensus found among passing sources.';
  }

  // ── GET: fetch & group news ───────────────────────────────────────────────
  if (req.method === 'GET') {
    const getIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    try {
      const sbForLimit = _getSupabase();
      const key = `${getIp}:analyze:get`;
      const now = new Date();
      const windowStart = new Date(now - 60000);
      const { data: rlData } = await sbForLimit.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
      if (rlData && new Date(rlData.window_start) >= windowStart && rlData.count >= 10) {
        return res.status(429).json({ error: 'Too many requests — try again in a minute.' });
      }
      if (!rlData || new Date(rlData.window_start) < windowStart) {
        await sbForLimit.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      } else {
        await sbForLimit.from('rate_limits').update({ count: rlData.count + 1 }).eq('key', key);
      }
    } catch (_) { /* fail open if Supabase not configured */ }

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
        'crypto':          ['bitcoin price rally crash', 'ethereum ETH market', 'SEC crypto lawsuit enforcement', 'MiCA Europe crypto regulation', 'Japan Korea Asia crypto policy', 'bitcoin ETF blackrock fidelity institutional', 'DeFi protocol hack exploit vulnerability', 'stablecoin USDT USDC depeg', 'binance coinbase crypto exchange', 'solana XRP altcoin', 'crypto whale liquidation funding rate', 'bitcoin mining hash rate difficulty'],
        'consumer':        ['retail sales consumer spending', 'walmart amazon target earnings', 'consumer confidence retail', 'e-commerce spending', 'consumer prices inflation'],
        'healthcare':      ['pharma FDA drug approval', 'healthcare biotech earnings', 'drug pricing pharma stocks', 'clinical trial biotech FDA', 'health insurance UnitedHealth Humana', 'Pfizer Moderna Merck Johnson', 'hospital Medicare Medicaid policy', 'cancer treatment biotech pipeline'],
        'defense':         ['defense stocks military spending', 'lockheed boeing raytheon', 'NATO defense budget', 'weapons contracts pentagon', 'geopolitical defense']
      };

      const queries = categoryQueries[category] || categoryQueries['any'];
      const indianKeywords = ['nse', 'bse', 'sensex', 'nifty', 'rupee', 'crore', 'lakh', 'sebi', 'rbi', 'swiggy', 'zomato'];

      const BASE_DIRECT_FEEDS = [
        { url: 'https://feeds.reuters.com/reuters/businessNews',                     source: 'Reuters' },
        { url: 'https://feeds.reuters.com/reuters/topNews',                           source: 'Reuters' },
        { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html',               source: 'CNBC' },
        { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',               source: 'CNBC' },
        { url: 'https://feeds.marketwatch.com/marketwatch/topstories/',               source: 'MarketWatch' },
        { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                      source: 'The Wall Street Journal' },
        { url: 'https://www.economist.com/finance-and-economics/rss.xml',             source: 'The Economist' },
        { url: 'https://feeds.npr.org/1017/rss.xml',                                  source: 'NPR' },
      ];
      const CATEGORY_DIRECT_FEEDS = {
        technology:      [{ url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html', source: 'CNBC' }],
        energy:          [{ url: 'https://feeds.reuters.com/reuters/energy',              source: 'Reuters' }],
        healthcare:      [
          { url: 'https://feeds.reuters.com/reuters/health',                              source: 'Reuters' },
          { url: 'https://www.cnbc.com/id/10000108/device/rss/rss.html',                  source: 'CNBC' },
        ],
        crypto:          [
          { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',        source: 'CoinDesk' },
          { url: 'https://www.theblock.co/rss.xml',                        source: 'The Block' },
          { url: 'https://decrypt.co/feed',                                source: 'Decrypt' },
          { url: 'https://cointelegraph.com/rss',                          source: 'Cointelegraph' },
          { url: 'https://forkast.news/feed/',                             source: 'Forkast' },
        ],
      };
      const directFeeds = [...BASE_DIRECT_FEEDS, ...(CATEGORY_DIRECT_FEEDS[category] || [])];
      const googleUrls = queries.map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
      if (category === 'crypto') {
        ['bitcoin crypto regulation', 'ethereum crypto market', 'crypto exchange hack'].forEach(q => {
          googleUrls.push(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`);
          googleUrls.push(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-SG&gl=SG&ceid=SG:en`);
        });
      }

      function fetchWithTimeout(url, timeoutMs) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      }
      function parseRssItems(text, fallbackSource) {
        const items = [];
        for (const match of [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)]) {
          const item = match[1];
          const titleMatch   = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
          const sourceMatch  = item.match(/<source[^>]*>(.*?)<\/source>/);
          const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
          if (titleMatch) {
            const title   = titleMatch[1].replace(/<[^>]*>/g, '').trim();
            const source  = sourceMatch ? sourceMatch[1].replace(/<[^>]*>/g, '').trim() : fallbackSource;
            const pubDate = pubDateMatch ? pubDateMatch[1] : '';
            if (title.length > 15) items.push({ title, source, date: pubDate });
          }
        }
        return items;
      }

      const [googleResults, directResults, fearGreed] = await Promise.all([
        Promise.allSettled(googleUrls.map(url => fetchWithTimeout(url, 8000))),
        Promise.allSettled(directFeeds.map(f => fetchWithTimeout(f.url, 5000).then(r => ({ res: r, source: f.source })))),
        category === 'crypto' ? _fetchCryptoFearGreed() : Promise.resolve(null)
      ]);

      let rawItems = [];
      for (const result of googleResults) {
        if (result.status === 'fulfilled') {
          try { for (const item of parseRssItems(await result.value.text(), 'Unknown')) rawItems.push({ ...item, grade: getSourceGrade(item.source) }); } catch (_) {}
        }
      }
      for (const result of directResults) {
        if (result.status === 'fulfilled') {
          try { const { res, source } = result.value; for (const item of parseRssItems(await res.text(), source)) rawItems.push({ ...item, grade: getSourceGrade(item.source) }); } catch (_) {}
        }
      }

      if (timeframe && timeframe !== 'any') {
        rawItems = rawItems.filter(a => {
          if (!a.date) return true;
          const days = (new Date() - new Date(a.date)) / 86400000;
          if (timeframe === 'today'  && days > 2) return false;
          if (timeframe === '3days'  && days > 3) return false;
          if (timeframe === '7days'  && days > 7) return false;
          return true;
        });
      }
      if (category !== 'crypto') rawItems = rawItems.filter(a => !indianKeywords.some(k => a.title.toLowerCase().includes(k)));
      if (selectedGrade !== 'all') rawItems = rawItems.filter(a => gradeScores[a.grade.toLowerCase()] >= threshold);

      const seen = new Set();
      const deduped = rawItems.filter(a => {
        const key = a.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 2).slice(0, 8).join(' ');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (deduped.length === 0) return res.status(200).json({ groups: [] });

      const categoryLabels = {
        'any': 'general financial markets', 'macro': 'macroeconomics and monetary policy',
        'technology': 'technology sector', 'energy': 'energy sector', 'financials': 'financial sector',
        'precious-metals': 'precious metals and commodities', 'real-estate': 'real estate and housing',
        'crypto': 'cryptocurrency and blockchain', 'consumer': 'consumer spending and retail',
        'healthcare': 'healthcare, pharmaceutical, and biotech sectors', 'defense': 'defense and aerospace sector'
      };
      const categoryLabel = categoryLabels[category] || 'financial markets';

      const groupPrompt = category === 'crypto'
        ? `You are a senior crypto markets analyst covering global cryptocurrency and blockchain markets. Here are ${deduped.length} headlines from global sources. Group them into distinct specific crypto market events.
${fearGreed ? `\nCrypto Fear & Greed Index right now: ${fearGreed.value}/100 — ${fearGreed.label}. Use this to contextualise sentiment-driven events.\n` : ''}
Headlines:
${deduped.map((a, i) => `${i + 1}. "${a.title}" — ${a.source}`).join('\n')}

STRICT RULES:
1. Cover ALL global crypto events — regulatory (any jurisdiction: US SEC, EU MiCA, Asia), protocol, exchange, institutional, macro impact on crypto
2. Merge ALL headlines about the same specific event into ONE group — be aggressive about merging
3. Topics must be SPECIFIC: name the coin, protocol, regulator, or exchange
4. Group by event, not by asset — "SEC sues Binance" is one group, not a Binance group and an SEC group
5. Do NOT create separate groups for variations of the same story
6. Include hacks, exploits, delistings, regulatory actions from any country
7. Aim for 10-15 highly distinct specific groups
8. Maximum 15 groups
9. Each index appears in exactly one group
10. Include ALL relevant indices in each group — do not leave articles ungrouped if they belong to a topic

Respond ONLY with valid JSON, no markdown:
{"groups":[{"topic":"Specific descriptive title","indices":[1,3,5,7,12,18,24,31]}]}`
        : `You are a senior financial news editor at The Economist specializing in ${categoryLabel}. Here are ${deduped.length} headlines. Group them into distinct specific market events RELEVANT TO ${categoryLabel.toUpperCase()}.

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
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 6000, messages: [{ role: 'user', content: groupPrompt }] })
      });
      const groupData = await groupRes.json();
      if (groupData.error) return res.status(500).json({ error: groupData.error.message });

      const grouped = JSON.parse(groupData.content[0].text.replace(/```json|```/g, '').trim());
      const groups = grouped.groups.map(g => {
        const groupArticles = g.indices.map(i => deduped[i - 1]).filter(Boolean);
        const uniqueSources = [...new Set(groupArticles.map(a => a.source))];
        const sourceGrades = {};
        uniqueSources.forEach(s => { sourceGrades[s] = getSourceGrade(s); });
        return { topic: g.topic, sources: uniqueSources, sourceGrades, minGrade: selectedGrade, totalSources: groupArticles.length, headlines: groupArticles.map(a => a.title), dates: groupArticles.map(a => a.date) };
      });

      const sortPrompt = category === 'crypto'
        ? `Rank these crypto market events by how likely they are to move total crypto market prices in the next 24 hours.${fearGreed ? ` Current sentiment: Fear & Greed ${fearGreed.value}/100 (${fearGreed.label}).` : ''}

Topics:
${groups.map((g, i) => `${i + 1}. ${g.topic} (${g.totalSources} sources)`).join('\n')}

Respond ONLY with valid JSON, no markdown:
{"ranked":[2,1,4,3,5]}`
        : `Rank these market topics by how likely they are to actually move US stock prices today, from most to least impactful.

Topics:
${groups.map((g, i) => `${i + 1}. ${g.topic} (${g.totalSources} sources)`).join('\n')}

Respond ONLY with valid JSON, no markdown:
{"ranked":[2,1,4,3,5]}`;

      try {
        const sortRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: sortPrompt }] })
        });
        const sortData = await sortRes.json();
        const sorted = JSON.parse(sortData.content[0].text.replace(/```json|```/g, '').trim());
        return res.status(200).json({ groups: sorted.ranked.map(i => groups[i - 1]).filter(Boolean) });
      } catch (_) {
        return res.status(200).json({ groups });
      }

    } catch (err) {
      console.error('[analyze GET]', err.message);
      return res.status(500).json({ error: 'Failed to fetch analysis' });
    }
  }

  // ── POST: deep analysis + save prediction ─────────────────────────────────
  if (req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

    let supabase = null;
    try { supabase = _getSupabase(); } catch (_) { /* Supabase not configured — skip rate limiting and persistence */ }

    if (supabase) {
      const allowed = await _checkRateLimit(supabase, ip, 20);
      if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });
    }

    const {
      topic: rawTopic,
      headlines: rawHeadlines,
      sources: rawSources,
      sourceGrades: rawSourceGrades = {},
      minGrade = 'medium',
      impactTimeframe: rawTimeframe
    } = req.body || {};

    const topic           = _sanitize(rawTopic, 300);
    const headlines       = _sanitizeArray(rawHeadlines);
    const sources         = _sanitizeArray(rawSources, 100, 40);
    const sourceGrades    = _sanitizeObject(rawSourceGrades);
    const impactTimeframe = _sanitize(rawTimeframe, 80);

    if (!topic) return res.status(400).json({ error: 'No topic provided' });

    try {
      const [relevantMarkets] = await Promise.all([_fetchRelevantMarkets(topic)]);

      const thresholdText = minGrade === 'all' ? 'all provided sources' : `sources with factuality grade ${minGrade.charAt(0).toUpperCase() + minGrade.slice(1)} or higher`;
      const consensus = buildConsensusSummary({ headlines, sources, sourceGrades, minGrade, reputation: {} });

      const marketsSection = relevantMarkets.length
        ? `\nRelated prediction market odds (Polymarket, live):\n${relevantMarkets.map(m => `- "${m.question}": ${m.yesPrice}% YES ($${Math.round(m.volume24h / 1000)}K 24h vol)`).join('\n')}\nThese represent crowd consensus on related outcomes — use them to calibrate your confidence.\n`
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

Consensus summary: ${consensus}
${marketsSection}
Only use ${thresholdText} for this analysis.

Analyze with the precision of a Goldman Sachs research note. Focus on the SPECIFIC event, not general trends. Impact timeframe: ${impactTimeframe || '1 month'}.

CRITICAL RULES:
- Beneficiaries and losers must ONLY reference stocks ETFs or bonds traded on US exchanges (NYSE NASDAQ CBOE)
- No foreign-listed stocks (no .NS .TO .L .DE .HK suffixes)
- Foreign companies that trade as ADRs in the US may use their US ADR ticker
- Sectors should reflect US market sectors only
- Confidence must be a number from 1 to 5 (stars) followed by a dash and a specific reason.

Respond ONLY with valid JSON, no markdown:
{
  "why_it_matters": "2-3 sentences on specific economic significance with concrete numbers where possible",
  "impact_timeframe": "Specific timeframe e.g. Immediate within 48 hours or Over the next 2-4 weeks",
  "crowd_summary": "1 sentence: what specific outcome the public is leaning toward and why, based on prediction market odds",
  "sectors": { "positive": ["US sector 1"], "negative": ["US sector 2"], "neutral": [] },
  "winners": { "explanation": "Why these specific US-listed stocks or ETFs benefit", "tickers": ["TICK1","TICK2"] },
  "losers":  { "explanation": "Why these specific US-listed stocks or ETFs are hurt",  "tickers": ["TICK3"] },
  "confidence": "4 — specific reason"
}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
      });

      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });

      const analysis = JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim());

      const predictionId    = `pred_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const winnerTickers   = analysis.winners?.tickers || [];
      const loserTickers    = analysis.losers?.tickers  || [];
      const allTickers      = [...new Set([...winnerTickers, ...loserTickers])];
      const baselinePrices  = await _fetchPrices(allTickers);
      const timeframeDays   = _parseTimeframeDays(analysis.impact_timeframe || impactTimeframe);
      const validationDate  = new Date(Date.now() + timeframeDays * 86400000).toISOString();

      if (supabase) await _savePrediction(supabase, {
        id: predictionId,
        created_at:        new Date().toISOString(),
        topic,
        sources,
        source_grades:     sourceGrades,
        min_grade:         minGrade,
        impact_timeframe:  impactTimeframe || null,
        analysis,
        winner_tickers:    winnerTickers,
        loser_tickers:     loserTickers,
        baseline_prices:   baselinePrices,
        validation_date:   validationDate,
        correct:           null,
        notes:             null
      });

      return res.status(200).json({ ...analysis, predictionId });

    } catch (err) {
      console.error('[analyze POST]', err.message);
      return res.status(500).json({ error: 'Analysis failed' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
