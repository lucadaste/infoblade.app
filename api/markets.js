// Tags are intentionally exclusive — no tag appears in more than one category
const CATEGORY_TAGS = {
  sports:        ['nba', 'nfl', 'mlb', 'nhl', 'mls', 'tennis', 'golf', 'mma', 'boxing', 'soccer', 'basketball', 'football', 'baseball', 'sports'],
  politics:      ['politics', 'elections', 'government', 'congress', 'supreme-court', 'trump'],
  finance:       ['finance', 'economics', 'bitcoin', 'ethereum', 'crypto', 'business', 'markets'],
  entertainment: ['entertainment', 'movies', 'tv', 'awards', 'oscars', 'grammys', 'music'],
  celebrity:     ['celebrity', 'pop-culture', 'culture']
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { category = 'sports', maxDays = '365', minDays = '0' } = req.query;
  const targetTags = CATEGORY_TAGS[category] || CATEGORY_TAGS.sports;
  const daysCap = Math.min(Math.max(parseInt(maxDays) || 365, 1), 365);
  const daysMin = Math.max(parseInt(minDays) || 0, 0);

  try {
    const now = new Date();
    const endDateMax = new Date(now.getTime() + daysCap * 86400000).toISOString();
    const endDateMin = new Date(now.getTime() + daysMin * 86400000).toISOString();

    const polyUrl = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=300&order=volume24hr&ascending=false&end_date_min=${encodeURIComponent(endDateMin)}&end_date_max=${encodeURIComponent(endDateMax)}`;

    const polyRes = await fetch(
      polyUrl,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    );
    const events = await polyRes.json();
    const filtered = (Array.isArray(events) ? events : []).filter(event => {
      if (!event.active || event.closed || event.archived) return false;
      const eventTags = (event.tags || []).map(t => (t.slug || t.label || '').toLowerCase());
      return targetTags.some(tag => eventTags.some(et => et.includes(tag)));
    });

    const markets = filtered.map(event => {
      const ms = event.markets || [];
      const primary = ms.length === 1
        ? ms[0]
        : [...ms].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];

      if (!primary) return null;

      // use primary market's endDate first — event.endDate is often null even when the market has one
      const endDate = primary.endDate || event.endDate || null;
      const daysLeft = endDate ? Math.ceil((new Date(endDate) - now) / 86400000) : null;

      // enforce timeframe window now that we have the real endDate
      if (daysLeft !== null && (daysLeft > daysCap || daysLeft < daysMin)) return null;

      let yesPrice = null;
      try {
        const prices = typeof primary.outcomePrices === 'string'
          ? JSON.parse(primary.outcomePrices)
          : primary.outcomePrices;
        yesPrice = Math.round(parseFloat(prices[0]) * 100);
      } catch (_) {}

      if (yesPrice === null || yesPrice < 20 || yesPrice > 80) return null;
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
    }).filter(Boolean).slice(0, 10);

    return res.status(200).json({ markets, category });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
