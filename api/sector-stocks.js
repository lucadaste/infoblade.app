const SECTOR_STOCKS = {
  'any':             [['SPY','S&P 500 ETF'],['QQQ','Nasdaq 100 ETF'],['IWM','Russell 2000 ETF'],['DIA','Dow Jones ETF'],['VTI','Total Market ETF']],
  'macro':           [['TLT','20yr Treasury ETF'],['GLD','Gold ETF'],['HYG','High Yield Bond ETF'],['UUP','US Dollar ETF'],['BND','Total Bond ETF']],
  'technology':      [['AAPL','Apple'],['MSFT','Microsoft'],['NVDA','Nvidia'],['GOOGL','Alphabet'],['META','Meta'],['AMZN','Amazon'],['AMD','AMD'],['AVGO','Broadcom']],
  'energy':          [['XOM','ExxonMobil'],['CVX','Chevron'],['COP','ConocoPhillips'],['OXY','Occidental Petroleum'],['SLB','SLB'],['XLE','Energy Select ETF'],['HAL','Halliburton']],
  'financials':      [['JPM','JPMorgan Chase'],['GS','Goldman Sachs'],['BAC','Bank of America'],['MS','Morgan Stanley'],['V','Visa'],['MA','Mastercard'],['WFC','Wells Fargo']],
  'precious-metals': [['GLD','Gold ETF'],['SLV','Silver ETF'],['GDX','Gold Miners ETF'],['NEM','Newmont'],['GOLD','Barrick Gold'],['WPM','Wheaton Precious Metals'],['AEM','Agnico Eagle']],
  'real-estate':     [['VNQ','Real Estate ETF'],['AMT','American Tower'],['PLD','Prologis'],['EQIX','Equinix'],['PSA','Public Storage'],['SPG','Simon Property Group'],['AVB','AvalonBay']],
  'consumer':        [['WMT','Walmart'],['COST','Costco'],['AMZN','Amazon'],['TGT','Target'],['NKE','Nike'],['MCD',"McDonald's"],['SBUX','Starbucks']],
  'healthcare':      [['UNH','UnitedHealth Group'],['LLY','Eli Lilly'],['JNJ','Johnson & Johnson'],['ABBV','AbbVie'],['PFE','Pfizer'],['MRK','Merck'],['TMO','Thermo Fisher']],
  'defense':         [['LMT','Lockheed Martin'],['RTX','RTX Corporation'],['NOC','Northrop Grumman'],['GD','General Dynamics'],['BA','Boeing'],['HII','Huntington Ingalls'],['LHX','L3Harris']],
  'crypto':          [['COIN','Coinbase'],['MSTR','MicroStrategy'],['MARA','MARA Holdings'],['RIOT','Riot Platforms'],['IBIT','iShares Bitcoin ETF'],['FBTC','Fidelity Bitcoin ETF']],
};

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function _parseRss(text, fallback, max = 7) {
  const items = [];
  for (const m of [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)]) {
    if (items.length >= max) break;
    const raw = m[1];
    const t = raw.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || raw.match(/<title>(.*?)<\/title>/);
    const s = raw.match(/<source[^>]*>(.*?)<\/source>/);
    if (t) {
      const title = t[1].replace(/<[^>]*>/g, '').trim();
      if (title.length > 15) items.push({ title, source: s ? s[1].replace(/<[^>]*>/g, '').trim() : fallback });
    }
  }
  return items;
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const sector  = req.query.sector || 'technology';
  const pairs   = SECTOR_STOCKS[sector] || SECTOR_STOCKS['technology'];

  const results = await Promise.allSettled(pairs.map(async ([ticker, name]) => {
    const shortName = name.split(' ')[0];
    const newsQ     = `${ticker} ${shortName} stock`;
    const gdeltQ    = `${ticker} ${shortName}`;

    const [quoteRes, newsRes, gdeltRes] = await Promise.allSettled([
      fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&fields=regularMarketPrice,regularMarketChangePercent,fiftyTwoWeekHigh,fiftyTwoWeekLow,marketCap`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(newsQ)}&hl=en-US&gl=US&ceid=US:en`, {
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(gdeltQ)}&mode=artlist&format=json&maxrecords=8&timespan=48h&sort=DateDesc&sourcelang=english`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
      }),
    ]);

    let price = null, changePct = null, week52High = null, week52Low = null;
    if (quoteRes.status === 'fulfilled') {
      try {
        const d = await quoteRes.value.json();
        const q = d?.quoteResponse?.result?.[0];
        if (q) {
          price      = q.regularMarketPrice        ? +q.regularMarketPrice.toFixed(2)        : null;
          changePct  = q.regularMarketChangePercent ? +q.regularMarketChangePercent.toFixed(2) : null;
          week52High = q.fiftyTwoWeekHigh           ? +q.fiftyTwoWeekHigh.toFixed(2)           : null;
          week52Low  = q.fiftyTwoWeekLow            ? +q.fiftyTwoWeekLow.toFixed(2)            : null;
        }
      } catch (_) {}
    }

    const headlines = [], sources = [];
    if (newsRes.status === 'fulfilled') {
      try {
        _parseRss(await newsRes.value.text(), 'Google News').forEach(i => {
          headlines.push(i.title); sources.push(i.source);
        });
      } catch (_) {}
    }
    if (gdeltRes.status === 'fulfilled') {
      try {
        const d = await gdeltRes.value.json();
        for (const art of d.articles || []) {
          if (art.title && art.title.length > 15 && headlines.length < 12) {
            headlines.push(art.title);
            sources.push(art.domain || 'Web');
          }
        }
      } catch (_) {}
    }

    return { ticker, name, price, changePct, week52High, week52Low, headlines: headlines.slice(0, 10), sources: sources.slice(0, 10) };
  }));

  const tickers = results
    .filter(r => r.status === 'fulfilled' && r.value.headlines.length >= 2)
    .map(r => r.value);

  return res.status(200).json({ tickers, sector });
}
