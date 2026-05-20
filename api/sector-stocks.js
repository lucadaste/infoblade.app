function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Yahoo Finance crumb cache (survives warm lambda invocations)
let _crumb = null;
let _cookie = null;
let _crumbTs = 0;

async function _refreshCrumb() {
  if (_crumb && Date.now() - _crumbTs < 3_600_000) return;
  try {
    const r1 = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    const raw = r1.headers.get('set-cookie') || '';
    _cookie = raw.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': _cookie,
      },
      signal: AbortSignal.timeout(5000),
    });
    const text = (await r2.text()).trim();
    if (text && !text.startsWith('<') && text.length < 60) {
      _crumb = text;
      _crumbTs = Date.now();
    }
  } catch (_) {}
}

async function _fetchFromRobinhood(symbols) {
  const url = `https://api.robinhood.com/quotes/?symbols=${symbols.join(',')}&bounds=trading`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Robinhood HTTP ${res.status}`);
  const data = await res.json();
  const map = {};
  for (const q of (data.results || [])) {
    if (!q?.symbol) continue;
    const price    = parseFloat(q.last_trade_price ?? q.last_extended_hours_trade_price ?? 0);
    const prev     = parseFloat(q.adjusted_previous_close ?? q.previous_close ?? 0);
    const changePct = (price > 0 && prev > 0) ? (price - prev) / prev * 100 : null;
    map[q.symbol] = {
      price:      price > 0 ? +price.toFixed(2)           : null,
      changePct:  changePct != null ? +changePct.toFixed(2) : null,
      week52High: null,
      week52Low:  null,
    };
  }
  return map;
}

async function _fetchFromYahoo(symbols) {
  await _refreshCrumb();
  const joined = symbols.join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(joined)}&fields=regularMarketPrice,regularMarketChangePercent,fiftyTwoWeekHigh,fiftyTwoWeekLow${_crumb ? `&crumb=${encodeURIComponent(_crumb)}` : ''}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };
  if (_cookie) headers['Cookie'] = _cookie;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  const map = {};
  for (const q of data?.quoteResponse?.result || []) {
    map[q.symbol] = {
      price:      q.regularMarketPrice           != null ? +q.regularMarketPrice.toFixed(2)           : null,
      changePct:  q.regularMarketChangePercent   != null ? +q.regularMarketChangePercent.toFixed(2)   : null,
      week52High: q.fiftyTwoWeekHigh             != null ? +q.fiftyTwoWeekHigh.toFixed(2)             : null,
      week52Low:  q.fiftyTwoWeekLow              != null ? +q.fiftyTwoWeekLow.toFixed(2)              : null,
    };
  }
  return map;
}

async function _fetchPrices(symbols) {
  // Try Robinhood first — no auth required, reliable server-side
  try {
    const map = await _fetchFromRobinhood(symbols);
    const hits = Object.values(map).filter(v => v.price != null).length;
    if (hits >= Math.min(3, Math.ceil(symbols.length * 0.15))) return map;
  } catch (_) {}
  // Fall back to Yahoo Finance with crumb authentication
  return _fetchFromYahoo(symbols);
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const sector = req.query.sector || 'any';

  const SECTOR_STOCKS = {
    'any': ['SPY','QQQ','IWM','DIA','AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','ORCL','AMD','CRM','INTC','QCOM','AMAT','MU','NOW','PANW','INTU','ADBE','SNOW','PLTR','UBER','JPM','BAC','GS','MS','V','MA','WFC','AXP','BLK','C','SCHW','UNH','LLY','JNJ','ABBV','PFE','MRK','TMO','AMGN','GILD','ISRG','XOM','CVX','COP','OXY','SLB','WMT','COST','MCD','SBUX','NKE','TGT','HD','KO','PEP','PG','LULU','NFLX','DIS','SPOT','CMCSA','T','VZ','SNAP','GE','CAT','RTX','LMT','BA','NOC','HON','DE','SHOP','MELI','SQ','ABNB','RBLX','PINS','COIN','MSTR','MARA','RIOT','GLD','SLV','TLT','XLE','XLF','XLK','XLV','IBIT','GDX','VNQ','HYG'],
    'technology':      ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','AMD','AVGO','ORCL','CRM','INTC','QCOM','AMAT','MU','NOW','PANW','INTU','ADBE','PLTR','SNOW'],
    'macro':           ['TLT','GLD','HYG','UUP','BND','SHY','IEF','LQD'],
    'energy':          ['XOM','CVX','COP','OXY','SLB','XLE','HAL','MRO','PSX','VLO'],
    'financials':      ['JPM','GS','BAC','MS','V','MA','WFC','AXP','BLK','C','SCHW','USB','PNC'],
    'precious-metals': ['GLD','SLV','GDX','GDXJ','NEM','GOLD','WPM','AEM','FNV'],
    'real-estate':     ['VNQ','AMT','PLD','EQIX','PSA','SPG','AVB','DLR','O','SBAC'],
    'consumer':        ['WMT','COST','AMZN','TGT','NKE','MCD','SBUX','PG','KO','PEP','LULU','HD','LOW'],
    'healthcare':      ['UNH','LLY','JNJ','ABBV','PFE','MRK','TMO','AMGN','GILD','CVS','ISRG','DHR'],
    'defense':         ['LMT','RTX','NOC','GD','BA','HII','LHX','LDOS','CACI','KTOS'],
    'crypto':          ['COIN','MSTR','MARA','RIOT','IBIT','FBTC','CLSK','WGMI','BITO'],
  };

  const symbols = SECTOR_STOCKS[sector] || SECTOR_STOCKS['any'];

  try {
    const priceMap = await _fetchPrices(symbols);
    const tickers = symbols.map(ticker => ({
      ticker,
      price:      priceMap[ticker]?.price      ?? null,
      changePct:  priceMap[ticker]?.changePct  ?? null,
      week52High: priceMap[ticker]?.week52High ?? null,
      week52Low:  priceMap[ticker]?.week52Low  ?? null,
    }));
    return res.status(200).json({ tickers, sector });
  } catch (err) {
    const tickers = symbols.map(ticker => ({ ticker, price: null, changePct: null }));
    return res.status(200).json({ tickers, sector });
  }
}
