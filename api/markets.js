const CATEGORY_TAGS = {
  sports:        ['sports', 'nba', 'nfl', 'mlb', 'nhl', 'mls', 'tennis', 'golf', 'mma', 'boxing', 'soccer', 'basketball', 'football', 'baseball'],
  politics:      ['politics', 'elections', 'government', 'trump', 'congress', 'legal', 'law', 'supreme-court', 'court'],
  finance:       ['crypto', 'finance', 'economics', 'business', 'markets', 'bitcoin', 'ethereum'],
  entertainment: ['pop-culture', 'entertainment', 'music', 'movies', 'tv', 'awards', 'oscars', 'grammys'],
  celebrity:     ['pop-culture', 'celebrity', 'entertainment', 'music', 'culture']
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { category = 'sports' } = req.query;
  const targetTags = CATEGORY_TAGS[category] || CATEGORY_TAGS.sports;

  try {
    const polyRes = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume24hr&ascending=false',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    const events = await polyRes.json();

    const filtered = (Array.isArray(events) ? events : []).filter(event => {
      if (!event.active || event.closed || event.archived) return false;
      const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
      return targetTags.some(tag => eventTags.some(et => et.includes(tag)));
    });

    const markets = filtered.slice(0, 5).map(event => {
      const ms = event.markets || [];
      const primary = ms.length === 1
        ? ms[0]
        : [...ms].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];

      if (!primary) return null;

      let yesPrice = null;
      try {
        const prices = typeof primary.outcomePrices === 'string'
          ? JSON.parse(primary.outcomePrices)
          : primary.outcomePrices;
        yesPrice = Math.round(parseFloat(prices[0]) * 100);
      } catch (_) {}

      if (yesPrice === null || yesPrice < 1 || yesPrice > 99) return null;

      const endDate = primary.endDate || event.endDate || null;
      const daysLeft = endDate ? Math.ceil((new Date(endDate) - new Date()) / 86400000) : null;
      const volume24h = Math.round(parseFloat(event.volume24hr || 0));
      const volumeTotal = Math.round(parseFloat(event.volume || 0));

      return {
        id: event.id,
        slug: event.slug,
        title: event.title,
        question: primary.question || event.title,
        yesPrice,
        volume24h,
        volumeTotal,
        daysLeft,
        totalMarkets: ms.length,
        category
      };
    }).filter(Boolean);

    return res.status(200).json({ markets, category });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
