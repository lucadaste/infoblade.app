import { setCors, checkRateLimit, clientIp, getSupabase } from '../lib/http.js';

// ── Quote + price history for a single ticker ───────────────────────────────
// Powers stock.html's "Robinhood-style" per-ticker page: current price/change,
// day & 52-week range, volume, and a chart series for the selected range.
//
// Uses Yahoo's v8 chart endpoint directly (same one api/sector-stocks.js
// falls back to for index symbols) rather than the crumb-authenticated v7
// quote endpoint — it needs no crumb/cookie dance, and uniquely among our
// existing quote sources it also returns the historical candle series, not
// just a current snapshot. One endpoint covers both needs here.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Display-name aliases → real Yahoo symbols (mirrors api/sector-stocks.js —
// kept as a tiny local copy since it's the only alias this route needs).
const SYMBOL_ALIASES = { 'SPX': '^GSPC' };

const RANGE_PARAMS = {
  '1d':  { interval: '5m',  range: '1d'  },
  '5d':  { interval: '15m', range: '5d'  },
  '1mo': { interval: '1d',  range: '1mo' },
  '3mo': { interval: '1d',  range: '3mo' },
  '1y':  { interval: '1wk', range: '1y'  },
  '5y':  { interval: '1mo', range: '5y'  },
};

async function _fetchChart(symbol, { interval, range }) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result?.meta) throw new Error('No chart data');
  return result;
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

  const rangeKey = RANGE_PARAMS[req.query.range] ? req.query.range : '1d';
  const symbol = SYMBOL_ALIASES[rawTicker] || rawTicker;

  try {
    const result = await _fetchChart(symbol, RANGE_PARAMS[rangeKey]);
    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const series = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      series.push({ t: timestamps[i] * 1000, c: +closes[i].toFixed(4) });
    }

    const price = meta.regularMarketPrice ?? (series.length ? series[series.length - 1].c : null);
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = meta.regularMarketChangePercent != null
      ? +meta.regularMarketChangePercent.toFixed(2)
      : (price != null && prevClose ? +((price - prevClose) / prevClose * 100).toFixed(2) : null);
    const changeAbs = (price != null && prevClose != null) ? +(price - prevClose).toFixed(2) : null;

    return res.status(200).json({
      ticker: rawTicker,
      price: price != null ? +price.toFixed(2) : null,
      changePct, changeAbs,
      prevClose: prevClose != null ? +prevClose.toFixed(2) : null,
      open:       meta.regularMarketOpen    != null ? +meta.regularMarketOpen.toFixed(2)    : null,
      dayHigh:    meta.regularMarketDayHigh != null ? +meta.regularMarketDayHigh.toFixed(2) : null,
      dayLow:     meta.regularMarketDayLow  != null ? +meta.regularMarketDayLow.toFixed(2)  : null,
      week52High: meta.fiftyTwoWeekHigh     != null ? +meta.fiftyTwoWeekHigh.toFixed(2)     : null,
      week52Low:  meta.fiftyTwoWeekLow      != null ? +meta.fiftyTwoWeekLow.toFixed(2)      : null,
      volume:     meta.regularMarketVolume  ?? null,
      currency:   meta.currency || 'USD',
      exchangeName: meta.fullExchangeName || meta.exchangeName || null,
      asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
      range: rangeKey,
      series,
    });
  } catch (err) {
    console.error('[ticker-quote]', rawTicker, err.message);
    return res.status(502).json({ error: 'Could not load quote data for this ticker.' });
  }
}
