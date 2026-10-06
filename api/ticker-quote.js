import { setCors, checkRateLimit, clientIp, getSupabase } from '../lib/http.js';

// ── Quote + price history for a single ticker ───────────────────────────────
// Powers stock.html's "Robinhood-style" per-ticker page: current price/change,
// day range, volume, and a chart series for the selected range.
//
// Regular equities/ETFs go through Robinhood — api/quote-fetch.js's own
// comments explain why it's kept as the primary quote source everywhere else
// in this codebase (more reliable than Yahoo from cloud/serverless IPs), and
// unlike Yahoo it needs no crumb/cookie dance. It also turns out to have an
// undocumented-but-working historicals-by-symbol endpoint, so one provider
// covers both the snapshot and the chart series — confirmed live; an earlier
// version of this route used Yahoo's v8 chart endpoint alone and failed
// outright in production (Yahoo 429s on the same request from Vercel's IPs).
//
// Robinhood has no index data at all though (SPX has no Robinhood
// instrument), so index aliases (see SYMBOL_ALIASES) go through the same
// CNBC → Yahoo chart → Yahoo v7 cascade api/sector-stocks.js already uses for
// index quotes, best-effort for the chart series specifically.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RH_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };

const SYMBOL_ALIASES = { 'SPX': '^GSPC' };
const CNBC_SYMBOL_MAP = { 'SPX': '.SPX' };

const RANGES = {
  '1d':  { label: '1D' },
  '5d':  { label: '1W' },
  '1mo': { label: '1M' },
  '3mo': { label: '3M' },
  '1y':  { label: '1Y' },
  '5y':  { label: '5Y' },
};
// Robinhood's historicals endpoint: span=day is the only span that accepts
// bounds=trading (pre/regular/post); every other span is regular-hours only.
const RH_RANGE = {
  '1d':  { interval: '5minute',  span: 'day',   bounds: 'trading' },
  '5d':  { interval: '10minute', span: 'week'   },
  '1mo': { interval: 'day',      span: 'month'  },
  '3mo': { interval: 'day',      span: '3month' },
  '1y':  { interval: 'day',      span: 'year'   },
  '5y':  { interval: 'week',     span: '5year'  },
};

function _num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function _round(n, d = 2) { return n == null ? null : +n.toFixed(d); }

// ── Equity / ETF path (Robinhood) ───────────────────────────────────────────
async function _buildEquityResponse(ticker, rangeKey) {
  const rh = RH_RANGE[rangeKey];
  const histUrl = `https://api.robinhood.com/marketdata/historicals/${encodeURIComponent(ticker)}/?interval=${rh.interval}&span=${rh.span}${rh.bounds ? `&bounds=${rh.bounds}` : ''}`;
  const [quoteRes, histRes] = await Promise.all([
    fetch(`https://api.robinhood.com/quotes/?symbols=${encodeURIComponent(ticker)}&bounds=trading`, { headers: RH_HEADERS, signal: AbortSignal.timeout(8000) }),
    fetch(histUrl, { headers: RH_HEADERS, signal: AbortSignal.timeout(8000) }),
  ]);
  if (!quoteRes.ok) throw new Error(`Robinhood quote HTTP ${quoteRes.status}`);
  if (!histRes.ok)  throw new Error(`Robinhood historicals HTTP ${histRes.status}`);
  const quoteData = await quoteRes.json();
  const histData  = await histRes.json();
  const q = quoteData?.results?.[0];
  if (!q) throw new Error('No Robinhood quote for ticker');

  const price      = _num(q.last_trade_price) ?? _num(q.last_extended_hours_trade_price);
  const prevClose   = _num(histData.previous_close_price) ?? _num(q.previous_close) ?? _num(q.adjusted_previous_close);
  const changeAbs   = (price != null && prevClose) ? _round(price - prevClose) : null;
  const changePct   = (price != null && prevClose) ? _round((price - prevClose) / prevClose * 100) : null;

  const historicals = histData.historicals || [];
  const series = historicals
    .map(h => ({ t: new Date(h.begins_at).getTime(), c: _num(h.close_price) }))
    .filter(p => p.c != null && !isNaN(p.t));

  // Day range/volume/open: only cheap and meaningful off the '1d' (5-minute,
  // today) granularity — regular-session candles only, so pre/post-market
  // noise doesn't widen "today's range".
  let dayHigh = null, dayLow = null, volume = null, openPrice = null;
  if (rangeKey === '1d') {
    const reg = historicals.filter(h => h.session === 'reg');
    const relevant = reg.length ? reg : historicals;
    if (relevant.length) {
      dayHigh   = _round(Math.max(...relevant.map(h => _num(h.high_price)).filter(n => n != null)));
      dayLow    = _round(Math.min(...relevant.map(h => _num(h.low_price)).filter(n => n != null)));
      volume    = relevant.reduce((s, h) => s + (h.volume || 0), 0);
      openPrice = _round(_num(histData.open_price) ?? _num(relevant[0].open_price));
    }
  }

  // 52-week range: free (no extra request) when the selected range already
  // covers enough history to derive it from the series itself.
  let week52High = null, week52Low = null;
  if (rangeKey === '1y' || rangeKey === '5y') {
    const highs = historicals.map(h => _num(h.high_price)).filter(n => n != null);
    const lows  = historicals.map(h => _num(h.low_price)).filter(n => n != null);
    if (highs.length) { week52High = _round(Math.max(...highs)); week52Low = _round(Math.min(...lows)); }
  }

  return {
    ticker, price: _round(price), changePct, changeAbs, prevClose: _round(prevClose),
    open: openPrice, dayHigh, dayLow, week52High, week52Low, volume,
    currency: 'USD', exchangeName: null,
    asOf: Date.now(), range: rangeKey, series,
  };
}

// ── Index path (Yahoo/CNBC) — SPX etc. have no Robinhood instrument ───────
let _crumb = null, _cookie = null, _crumbTs = 0;
async function _refreshCrumb() {
  if (_crumb && Date.now() - _crumbTs < 3_600_000) return;
  try {
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    const raw = r1.headers.get('set-cookie') || '';
    _cookie = raw.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': _cookie }, signal: AbortSignal.timeout(5000) });
    const text = (await r2.text()).trim();
    if (text && !text.startsWith('<') && text.length < 60) { _crumb = text; _crumbTs = Date.now(); }
  } catch (_) {}
}

async function _cnbcQuote(displaySymbol) {
  const cnbcSym = CNBC_SYMBOL_MAP[displaySymbol];
  if (!cnbcSym) return null;
  try {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(cnbcSym)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q?.last) return null;
    const price = parseFloat(String(q.last).replace(/,/g, ''));
    const changePct = parseFloat(String(q.change_pct || '').replace(/%/g, ''));
    if (!price) return null;
    return { price: _round(price), changePct: !isNaN(changePct) ? _round(changePct) : null };
  } catch (_) { return null; }
}

async function _yahooChart(symbol, interval, range) {
  await _refreshCrumb();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}${_crumb ? `&crumb=${encodeURIComponent(_crumb)}` : ''}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' };
  if (_cookie) headers['Cookie'] = _cookie;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.chart?.result?.[0] || null;
}

const YAHOO_RANGE = {
  '1d': { interval: '5m', range: '1d' }, '5d': { interval: '15m', range: '5d' },
  '1mo': { interval: '1d', range: '1mo' }, '3mo': { interval: '1d', range: '3mo' },
  '1y': { interval: '1wk', range: '1y' }, '5y': { interval: '1mo', range: '5y' },
};

async function _buildIndexResponse(rawTicker, rangeKey) {
  const realSymbol = SYMBOL_ALIASES[rawTicker];
  const yp = YAHOO_RANGE[rangeKey];
  const chartResult = await _yahooChart(realSymbol, yp.interval, yp.range);

  let price = null, changePct = null, changeAbs = null, prevClose = null, series = [];
  if (chartResult?.meta) {
    const meta = chartResult.meta;
    price     = meta.regularMarketPrice ?? null;
    prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    changePct = meta.regularMarketChangePercent != null ? _round(meta.regularMarketChangePercent) : null;
    changeAbs = (price != null && prevClose) ? _round(price - prevClose) : null;
    const timestamps = chartResult.timestamp || [];
    const closes = chartResult.indicators?.quote?.[0]?.close || [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      series.push({ t: timestamps[i] * 1000, c: _round(closes[i], 4) });
    }
  }

  // CNBC quote as a best-effort override/fill for price+change specifically
  // (more reliable than Yahoo for index symbols — see api/sector-stocks.js).
  const cnbc = await _cnbcQuote(rawTicker);
  if (cnbc) {
    price = cnbc.price; changePct = cnbc.changePct;
    // CNBC doesn't return a previous-close; derive one from price+change% so
    // the stat tile isn't just blank when Yahoo's meta didn't come through.
    if (prevClose == null && price != null && changePct != null) {
      prevClose = _round(price / (1 + changePct / 100));
      changeAbs = _round(price - prevClose);
    }
  }

  if (price == null) throw new Error('No index quote available');

  return {
    ticker: rawTicker, price: _round(price), changePct, changeAbs, prevClose: _round(prevClose),
    open: null, dayHigh: null, dayLow: null, week52High: null, week52Low: null, volume: null,
    currency: 'USD', exchangeName: null,
    asOf: Date.now(), range: rangeKey, series,
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'ticker-quote', 60);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const rawTicker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10) : '';
  if (!rawTicker) return res.status(400).json({ error: 'No ticker provided' });
  const rangeKey = RANGES[req.query.range] ? req.query.range : '1d';

  try {
    const data = SYMBOL_ALIASES[rawTicker]
      ? await _buildIndexResponse(rawTicker, rangeKey)
      : await _buildEquityResponse(rawTicker, rangeKey);
    return res.status(200).json(data);
  } catch (err) {
    console.error('[ticker-quote]', rawTicker, err.message);
    return res.status(502).json({ error: 'Could not load quote data for this ticker.' });
  }
}
