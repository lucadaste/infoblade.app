// Returns all US-listed company tickers from SEC EDGAR (~12k entries).
// Cached 24h on Vercel's edge so downstream latency is negligible.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');

  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: {
        'User-Agent': 'InvestmentInformatics.AI contact@infoblade.app',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`SEC responded ${r.status}`);

    const data = await r.json();
    const tickers = Object.values(data)
      .map(c => ({ s: String(c.ticker).toUpperCase(), n: String(c.title) }))
      .filter(c => c.s && c.n && /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(c.s))
      .sort((a, b) => a.s.localeCompare(b.s));

    return res.status(200).json({ tickers });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
