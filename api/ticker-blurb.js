// Simple in-memory cache — survives within a serverless instance lifetime
const _cache = new Map();
const CACHE_TTL = 3_600_000; // 1 hour

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const ticker = (req.query.ticker || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 10);
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const hit = _cache.get(ticker);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json({ ticker, blurb: hit.blurb });
  }

  // Search for recent context via Tavily
  let snippets = '';
  if (process.env.TAVILY_API_KEY) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: `${ticker} stock company what it does recent news`,
          search_depth: 'basic',
          max_results: 3,
          days: 14,
        }),
        signal: AbortSignal.timeout(4000),
      });
      const d = await r.json();
      snippets = (d.results || [])
        .map(x => x.content || x.title || '')
        .filter(Boolean)
        .join(' ')
        .slice(0, 1200);
    } catch (_) {}
  }

  const context = snippets ? `\n\nContext:\n${snippets}` : '';
  const prompt = `Write 2-3 concise sentences about the stock ticker ${ticker}: first, what the company does and its core business; second, any notable recent news or developments.${context}\n\nBe factual and brief. No markdown, no opinions, no hedging phrases like "as of my knowledge".`;

  try {
    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 130,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const cd = await cr.json();
    const blurb = cd.content?.[0]?.text?.trim() || '';
    if (!blurb) return res.status(500).json({ error: 'No response from model' });

    _cache.set(ticker, { blurb, ts: Date.now() });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json({ ticker, blurb });
  } catch (_) {
    return res.status(500).json({ error: 'Service unavailable' });
  }
}
