function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Display-name aliases → real Yahoo Finance symbols
const SYMBOL_ALIASES = { 'SPX': '^GSPC' };
const ALIAS_REVERSE  = Object.fromEntries(Object.entries(SYMBOL_ALIASES).map(([k, v]) => [v, k]));

function _realSymbol(s) { return SYMBOL_ALIASES[s] || s; }
function _displaySymbol(s) { return ALIAS_REVERSE[s] || s; }

// CNBC symbol map for index symbols — CNBC's quote service works from cloud IPs
const CNBC_SYMBOL_MAP = { 'SPX': '.SPX' };

async function _fetchFromCNBC(displaySymbol) {
  const cnbcSym = CNBC_SYMBOL_MAP[displaySymbol];
  if (!cnbcSym) return null;
  try {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(cnbcSym)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q?.last) return null;
    const price     = parseFloat(String(q.last).replace(/,/g, ''));
    const changePct = parseFloat(String(q.change_pct || '').replace(/%/g, ''));
    if (!price) return null;
    return {
      price:      +price.toFixed(2),
      changePct:  !isNaN(changePct) ? +changePct.toFixed(2) : null,
      week52High: null,
      week52Low:  null,
    };
  } catch (_) { return null; }
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
    const price     = parseFloat(q.last_trade_price ?? q.last_extended_hours_trade_price ?? 0);
    const prev      = parseFloat(q.adjusted_previous_close ?? q.previous_close ?? 0);
    const changePct = (price > 0 && prev > 0) ? (price - prev) / prev * 100 : null;
    map[q.symbol] = {
      price:      price > 0 ? +price.toFixed(2)            : null,
      changePct:  changePct != null ? +changePct.toFixed(2) : null,
      week52High: null,
      week52Low:  null,
    };
  }
  return map;
}

async function _fetchFromYahoo(displaySymbols) {
  await _refreshCrumb();
  // Translate display names → real Yahoo symbols
  const realSymbols = displaySymbols.map(_realSymbol);
  const joined = realSymbols.join(',');
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
    // Map real symbol back to display name (e.g. ^GSPC → SPX)
    const key = _displaySymbol(q.symbol);
    map[key] = {
      price:      q.regularMarketPrice           != null ? +q.regularMarketPrice.toFixed(2)           : null,
      changePct:  q.regularMarketChangePercent   != null ? +q.regularMarketChangePercent.toFixed(2)   : null,
      week52High: q.fiftyTwoWeekHigh             != null ? +q.fiftyTwoWeekHigh.toFixed(2)             : null,
      week52Low:  q.fiftyTwoWeekLow              != null ? +q.fiftyTwoWeekLow.toFixed(2)              : null,
    };
  }
  return map;
}

// v8 chart API — no crumb/cookie needed, reliable fallback for index symbols.
// Uses range=5d so weekend/holiday calls still return the last available price.
async function _fetchChartFallback(displaySymbol) {
  const real = _realSymbol(displaySymbol);
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(real)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
    if (!price) return null;
    // Prefer the pre-computed change percent from Yahoo (accurate across sessions)
    const changePct = meta.regularMarketChangePercent != null
      ? meta.regularMarketChangePercent
      : (() => {
          const prev = meta.previousClose ?? meta.chartPreviousClose;
          return (prev && price !== prev) ? (price - prev) / prev * 100 : null;
        })();
    return {
      price:      +price.toFixed(2),
      changePct:  changePct != null ? +changePct.toFixed(2) : null,
      week52High: meta.fiftyTwoWeekHigh != null ? +meta.fiftyTwoWeekHigh.toFixed(2) : null,
      week52Low:  meta.fiftyTwoWeekLow  != null ? +meta.fiftyTwoWeekLow.toFixed(2)  : null,
    };
  } catch (_) { return null; }
}

async function _fetchPrices(displaySymbols) {
  const indices = displaySymbols.filter(s => _realSymbol(s).startsWith('^'));
  const regular = displaySymbols.filter(s => !_realSymbol(s).startsWith('^'));

  let map = {};

  // Regular symbols: try Robinhood first, fall back to Yahoo
  if (regular.length) {
    try {
      const rbMap = await _fetchFromRobinhood(regular);
      const hits = Object.values(rbMap).filter(v => v.price != null).length;
      if (hits >= Math.min(3, Math.ceil(regular.length * 0.15))) {
        map = rbMap;
      } else {
        map = await _fetchFromYahoo(regular);
      }
    } catch (_) {
      map = await _fetchFromYahoo(regular);
    }
  }

  // Index symbols: CNBC quote API first (works from cloud IPs, no auth),
  // then Yahoo v8 chart as fallback, then Yahoo v7 as last resort.
  if (indices.length) {
    await Promise.all(indices.map(async sym => {
      const data = await _fetchFromCNBC(sym) ?? await _fetchChartFallback(sym);
      if (data) map[sym] = data;
    }));
    const missing = indices.filter(s => map[s]?.price == null);
    if (missing.length) {
      try {
        const idxMap = await _fetchFromYahoo(missing);
        Object.assign(map, idxMap);
      } catch (_) {}
    }
  }

  return map;
}

// Fetch Robinhood's 100-most-popular list; returns ordered array of symbols
async function _fetchPopularityRanking() {
  const RH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };
  try {
    const tagRes = await fetch('https://api.robinhood.com/midlands/tags/tag/100-most-popular/', {
      headers: RH_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    if (!tagRes.ok) return [];
    const tagData = await tagRes.json();
    const instrumentUrls = tagData.instruments || [];
    if (!instrumentUrls.length) return [];

    // Extract UUIDs from instrument URLs
    const ids = instrumentUrls.map(url => {
      const m = url.match(/\/instruments\/([a-f0-9-]+)\//i);
      return m ? m[1] : null;
    }).filter(Boolean);
    if (!ids.length) return [];

    // Batch-fetch symbols (up to 50 per request to stay safe)
    const allSymbols = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const instRes = await fetch(`https://api.robinhood.com/instruments/?ids=${chunk.join(',')}`, {
          headers: RH_HEADERS,
          signal: AbortSignal.timeout(8000),
        });
        if (!instRes.ok) continue;
        const instData = await instRes.json();
        // Preserve the order from the tag (instruments are popularity-ordered)
        const byId = {};
        for (const inst of instData.results || []) {
          if (inst.symbol && inst.id) byId[inst.id] = inst.symbol;
        }
        for (const id of chunk) {
          if (byId[id]) allSymbols.push(byId[id]);
        }
      } catch (_) {}
    }
    return allSymbols;
  } catch (_) {
    return [];
  }
}

export default async function handler(req, res) {
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const sector = req.query.sector || 'any';

  const SECTOR_STOCKS = {
    'any':           ['SPX','SPY','QQQ','IWM','DIA','AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','ORCL','AMD','CRM','INTC','QCOM','AMAT','MU','NOW','PANW','INTU','ADBE','SNOW','PLTR','UBER','JPM','BAC','GS','MS','V','MA','WFC','AXP','BLK','C','SCHW','UNH','LLY','JNJ','ABBV','PFE','MRK','TMO','AMGN','GILD','ISRG','XOM','CVX','COP','OXY','SLB','WMT','COST','MCD','SBUX','NKE','TGT','HD','KO','PEP','PG','LULU','NFLX','DIS','SPOT','CMCSA','T','VZ','SNAP','GE','CAT','RTX','LMT','BA','NOC','HON','DE','SHOP','MELI','SQ','ABNB','RBLX','PINS','COIN','MSTR','MARA','RIOT','GLD','SLV','TLT','XLE','XLF','XLK','XLV','IBIT','GDX','VNQ','HYG'],
    'technology':    ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','AMD','AVGO','ORCL','CRM','INTC','QCOM','AMAT','MU','NOW','PANW','INTU','ADBE','PLTR','SNOW'],
    'macro':         ['TLT','GLD','HYG','UUP','BND','SHY','IEF','LQD'],
    'energy':        ['XOM','CVX','COP','OXY','SLB','XLE','HAL','MRO','PSX','VLO'],
    'financials':    ['JPM','GS','BAC','MS','V','MA','WFC','AXP','BLK','C','SCHW','USB','PNC'],
    'precious-metals':['GLD','SLV','GDX','GDXJ','NEM','GOLD','WPM','AEM','FNV'],
    'real-estate':   ['VNQ','AMT','PLD','EQIX','PSA','SPG','AVB','DLR','O','SBAC'],
    'consumer':      ['WMT','COST','AMZN','TGT','NKE','MCD','SBUX','PG','KO','PEP','LULU','HD','LOW'],
    'healthcare':    ['UNH','LLY','JNJ','ABBV','PFE','MRK','TMO','AMGN','GILD','CVS','ISRG','DHR'],
    'defense':       ['LMT','RTX','NOC','GD','BA','HII','LHX','LDOS','CACI','KTOS'],
    'etfs':          ['SPX','SPY','QQQ','IWM','DIA','VTI','GLD','SLV','GDX','TLT','SHY','HYG','LQD','XLE','XLF','XLK','XLV','XLI','IBIT','VNQ'],
  };

  const baseSymbols = SECTOR_STOCKS[sector] || SECTOR_STOCKS['any'];
  let finalSymbols = baseSymbols;
  let popularitySorted = false;

  // For 'any' sector: sort by Robinhood real-time popularity, keeping SPX pinned first
  if (sector === 'any') {
    const ranking = await _fetchPopularityRanking();
    if (ranking.length > 0) {
      const rankMap = {};
      ranking.forEach((sym, i) => { rankMap[sym] = i; });

      const pinned  = baseSymbols.filter(s => _realSymbol(s).startsWith('^'));  // SPX etc always first
      const rest    = baseSymbols.filter(s => !_realSymbol(s).startsWith('^'));

      rest.sort((a, b) => {
        const ra = rankMap[a] ?? 9999;
        const rb = rankMap[b] ?? 9999;
        return ra - rb;
      });

      finalSymbols = [...pinned, ...rest];
      popularitySorted = true;
    }
  }

  try {
    const priceMap = await _fetchPrices(finalSymbols);
    const tickers = finalSymbols.map(ticker => ({
      ticker,
      price:      priceMap[ticker]?.price      ?? null,
      changePct:  priceMap[ticker]?.changePct  ?? null,
      week52High: priceMap[ticker]?.week52High ?? null,
      week52Low:  priceMap[ticker]?.week52Low  ?? null,
    }));
    return res.status(200).json({ tickers, sector, popularitySorted });
  } catch (err) {
    const tickers = finalSymbols.map(ticker => ({ ticker, price: null, changePct: null }));
    return res.status(200).json({ tickers, sector });
  }
}
