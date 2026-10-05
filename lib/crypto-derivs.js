/**
 * Perpetual-futures positioning for the crypto prediction prompt
 * (api/analyze.js): funding rate, open interest, and perp premium.
 *
 * Source is Hyperliquid's public info API, not Binance/Bybit — both of those
 * geo-block US IPs (Vercel's default region included), Hyperliquid doesn't,
 * and one metaAndAssetCtxs call covers every listed perp. No key needed.
 *
 * Hyperliquid funding is paid hourly and has a fixed interest component of
 * 0.00125%/hr (= 0.01% per 8h, the same neutral baseline Binance quotes), so
 * only the deviation from that baseline says anything about positioning.
 *
 * Best-effort: any failure returns null and the prompt simply omits the section.
 */

const HL_URL = 'https://api.hyperliquid.xyz/info';
const NEUTRAL_HOURLY = 0.0000125;
const CTX_TTL_MS = 60_000;

let _ctxCache = null; // { ts, byCoin }

async function _hlPost(body, timeoutMs = 4000) {
  const r = await fetch(HL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}

async function _assetContexts() {
  if (_ctxCache && Date.now() - _ctxCache.ts < CTX_TTL_MS) return _ctxCache.byCoin;
  const [meta, ctxs] = await _hlPost({ type: 'metaAndAssetCtxs' });
  const byCoin = {};
  (meta?.universe || []).forEach((u, i) => { if (ctxs?.[i]) byCoin[u.name] = ctxs[i]; });
  _ctxCache = { ts: Date.now(), byCoin };
  return byCoin;
}

async function _avgFunding24h(coin) {
  try {
    const rows = await _hlPost({ type: 'fundingHistory', coin, startTime: Date.now() - 86400000 });
    const rates = (rows || []).map(r => parseFloat(r.fundingRate)).filter(Number.isFinite);
    return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  } catch (_) { return null; }
}

// Hyperliquid lists some low-priced coins in thousands (kPEPE, kSHIB, kBONK).
function _hlName(symbol, byCoin) {
  if (byCoin[symbol]) return symbol;
  if (byCoin[`k${symbol}`]) return `k${symbol}`;
  return null;
}

/**
 * @param {string} symbol - raw coin symbol, e.g. 'BTC'
 * @returns {Promise<{fundingHourly: number, funding24hAvg: number|null,
 *   fundingPer8hPct: number, annualizedPct: number, openInterestUsd: number,
 *   premiumPct: number, volume24hUsd: number, perpChange24hPct: number|null,
 *   positioning: 'crowded long'|'crowded short'|'neutral'}|null>}
 */
export async function fetchCryptoDerivs(symbol) {
  if (!symbol) return null;
  try {
    const byCoin = await _assetContexts();
    const name = _hlName(symbol.toUpperCase(), byCoin);
    if (!name) return null;
    const c = byCoin[name];
    const funding = parseFloat(c.funding);
    const mark = parseFloat(c.markPx);
    const prevDay = parseFloat(c.prevDayPx);
    if (!Number.isFinite(funding) || !Number.isFinite(mark)) return null;

    const funding24hAvg = await _avgFunding24h(name);
    // Judge positioning on the 24h average when we have it — a single hourly
    // print can spike on one large order.
    const basis = funding24hAvg ?? funding;
    const positioning = basis >= NEUTRAL_HOURLY * 3 ? 'crowded long'
      : basis <= 0 ? 'crowded short'
      : 'neutral';

    return {
      fundingHourly: funding,
      funding24hAvg,
      fundingPer8hPct: +(basis * 8 * 100).toFixed(4),
      annualizedPct: +(basis * 24 * 365 * 100).toFixed(1),
      openInterestUsd: Math.round(parseFloat(c.openInterest) * mark),
      premiumPct: +(parseFloat(c.premium) * 100).toFixed(3),
      volume24hUsd: Math.round(parseFloat(c.dayNtlVlm)),
      perpChange24hPct: Number.isFinite(prevDay) && prevDay ? +((mark / prevDay - 1) * 100).toFixed(2) : null,
      positioning,
    };
  } catch (err) {
    console.error('[crypto-derivs]', symbol, err.message);
    return null;
  }
}

function _usd(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

export function formatDerivsForPrompt(symbol, d) {
  if (!d) return '';
  const sign = v => (v > 0 ? '+' : '');
  return `\nFUTURES POSITIONING (Hyperliquid perpetuals, ${symbol}):
- Funding ${sign(d.fundingPer8hPct)}${d.fundingPer8hPct}% per 8h${d.funding24hAvg != null ? ' (24h avg)' : ''}, ${sign(d.annualizedPct)}${d.annualizedPct}% annualized: ${d.positioning} (neutral baseline is +0.01% per 8h)
- Open interest ${_usd(d.openInterestUsd)}, 24h perp volume ${_usd(d.volume24hUsd)}${d.perpChange24hPct != null ? `, perp price ${sign(d.perpChange24hPct)}${d.perpChange24hPct}% 24h` : ''}
- Perp premium vs spot ${sign(d.premiumPct)}${d.premiumPct}%
How to read this: funding well above baseline means leveraged longs are paying to stay in, which often precedes a long squeeze (sharp drop) if price stalls; negative funding means shorts are crowded, which often precedes a short squeeze (sharp rise). Neutral funding means leverage is not leaning either way, so this section adds little. Treat crowded positioning as a reason to lean against the crowd on short horizons and to lower confidence on calls that agree with it.\n`;
}
