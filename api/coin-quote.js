import { setCors, checkRateLimit, clientIp, getSupabase } from '../lib/http.js';

// ── Quote + price history for a single crypto coin ─────────────────────────
// Crypto counterpart to api/ticker-quote.js, powering coin.html. CoinGecko's
// free, unauthenticated endpoints cover both needs directly (no Robinhood/
// Yahoo cascade needed here — api/crypto-prices.js already relies on the
// same provider for the grid, successfully, so this follows the same path)
// and are richer for crypto than what's available for equities: market cap,
// 24h volume/range, and all-time high come back on the snapshot call, so
// coin.html's stat tiles differ from stock.html's accordingly.
//
// Mirrors api/crypto-prices.js's COIN_IDS list (symbol → CoinGecko id) —
// kept as its own copy rather than imported, same tradeoff lib/coin-symbols.js
// documents for crypto.html's own inline copy: presentation/lookup data, not
// save-path logic, so a drift here just means a coin this route doesn't
// recognize yet, not silent data loss.
const COIN_ID_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin', XRP: 'ripple',
  AVAX: 'avalanche-2', SHIB: 'shiba-inu', LINK: 'chainlink', POL: 'matic-network',
  ADA: 'cardano', DOT: 'polkadot', NEAR: 'near', ATOM: 'cosmos', XLM: 'stellar',
  LTC: 'litecoin', ALGO: 'algorand', UNI: 'uniswap', AAVE: 'aave', MKR: 'maker',
  GRT: 'the-graph', FIL: 'filecoin', HBAR: 'hedera-hashgraph', ETC: 'ethereum-classic',
  BCH: 'bitcoin-cash', OP: 'optimism', ARB: 'arbitrum', SUI: 'sui', APT: 'aptos',
  PEPE: 'pepe', BAT: 'basic-attention-token', MANA: 'decentraland', SAND: 'the-sandbox',
};

const CG_DAYS = { '1d': '1', '5d': '7', '1mo': '30', '3mo': '90', '1y': '365', '5y': '1825' };

function _num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function _round(n, d = 2) { return n == null ? null : +n.toFixed(d); }

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'coin-quote', 60);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) : '';
  const id = COIN_ID_MAP[symbol];
  if (!id) return res.status(400).json({ error: 'Unknown coin symbol' });
  const rangeKey = CG_DAYS[req.query.range] ? req.query.range : '1d';

  try {
    const headers = { 'Accept': 'application/json' };
    if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;

    const [snapRes, chartRes] = await Promise.all([
      fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${CG_DAYS[rangeKey]}`, { headers, signal: AbortSignal.timeout(10000) }),
    ]);
    if (!snapRes.ok) throw new Error(`CoinGecko markets HTTP ${snapRes.status}`);
    const snapArr = await snapRes.json();
    const snap = Array.isArray(snapArr) ? snapArr[0] : null;
    if (!snap) throw new Error('No CoinGecko snapshot for coin');

    let series = [];
    if (chartRes.ok) {
      const chart = await chartRes.json();
      series = (chart.prices || [])
        .map(([t, c]) => ({ t, c: _round(c, c < 1 ? 6 : 2) }))
        .filter(p => p.c != null);
    }

    const price = _num(snap.current_price);
    const changePct = _num(snap.price_change_percentage_24h);
    const changeAbs = _num(snap.price_change_24h);

    return res.status(200).json({
      symbol, name: snap.name || symbol, image: snap.image || null,
      price, changePct: changePct != null ? _round(changePct) : null, changeAbs: changeAbs != null ? _round(changeAbs, 4) : null,
      high24h: _num(snap.high_24h), low24h: _num(snap.low_24h),
      marketCap: snap.market_cap ?? null, marketCapRank: snap.market_cap_rank ?? null,
      volume24h: snap.total_volume ?? null,
      ath: _num(snap.ath), athChangePct: _num(snap.ath_change_percentage), athDate: snap.ath_date || null,
      circulatingSupply: snap.circulating_supply ?? null,
      currency: 'USD', asOf: Date.now(), range: rangeKey, series,
    });
  } catch (err) {
    console.error('[coin-quote]', symbol, err.message);
    return res.status(502).json({ error: 'Could not load quote data for this coin.' });
  }
}
