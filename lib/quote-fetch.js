/**
 * Shared batched equity-quote fetching (Robinhood primary, Yahoo Finance
 * crumb-authenticated fallback). Extracted from api/sector-stocks.js's
 * regular-symbol path (the index/CNBC path stays there — it's index-specific
 * and not needed by anything else) so api/collect-price-snapshots.js can
 * reuse the exact same proven fetch pattern instead of re-implementing the
 * crumb dance a second time.
 *
 * NOTE on volume: Robinhood's quote payload has no volume field (confirmed
 * live), so a batch served from the Robinhood path returns price/changePct
 * only — volume stays null for those symbols. The Yahoo fallback path DOES
 * request regularMarketVolume (a standard field on this endpoint, alongside
 * the price/change/52-week fields sector-stocks.js already pulls from it
 * successfully), so volume is populated whenever that path is taken. This is
 * an accepted best-effort tradeoff, not a bug: Robinhood is kept as the
 * primary path because it's the more reliable one from cloud/serverless IPs
 * (see api/sector-stocks.js's own fallback-priority comments) — inverting
 * that priority just to chase volume on every call would trade reliability
 * for a field that lib/situation-similarity-stocks.js treats as optional.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _crumb = null;
let _cookie = null;
let _crumbTs = 0;

async function _refreshCrumb() {
  if (_crumb && Date.now() - _crumbTs < 3_600_000) return;
  try {
    const r1 = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    const raw = r1.headers.get('set-cookie') || '';
    _cookie = raw.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': _cookie },
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
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Robinhood HTTP ${res.status}`);
  const data = await res.json();
  const map = {};
  for (const q of (data.results || [])) {
    if (!q?.symbol) continue;
    const price = parseFloat(q.last_trade_price ?? q.last_extended_hours_trade_price ?? 0);
    map[q.symbol] = { price: price > 0 ? +price.toFixed(2) : null, volume: null };
  }
  return map;
}

async function _fetchFromYahoo(symbols) {
  await _refreshCrumb();
  const joined = symbols.join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(joined)}&fields=regularMarketPrice,regularMarketVolume${_crumb ? `&crumb=${encodeURIComponent(_crumb)}` : ''}`;
  const headers = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://finance.yahoo.com/' };
  if (_cookie) headers['Cookie'] = _cookie;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  const map = {};
  for (const q of data?.quoteResponse?.result || []) {
    map[q.symbol] = {
      price:  q.regularMarketPrice != null ? +q.regularMarketPrice.toFixed(2) : null,
      volume: q.regularMarketVolume ?? null,
    };
  }
  return map;
}

/**
 * @param {string[]} symbols - equity tickers (no index symbols like ^GSPC)
 * @returns {Promise<Record<string, {price: number|null, volume: number|null}>>}
 */
export async function fetchBatchedQuotes(symbols) {
  if (!symbols.length) return {};
  try {
    const rbMap = await _fetchFromRobinhood(symbols);
    const hits = Object.values(rbMap).filter(v => v.price != null).length;
    if (hits >= Math.min(3, Math.ceil(symbols.length * 0.15))) return rbMap;
    return await _fetchFromYahoo(symbols);
  } catch (_) {
    return await _fetchFromYahoo(symbols);
  }
}
