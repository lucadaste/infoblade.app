// Canonical list of crypto coins the platform recognizes for crypto-coin
// predictions. Shared between api/analyze.js (creates predictions),
// api/predictions.js (resolves/cleans them up), and api/generate-baseline.js
// (the daily baseline generator, which needs display names to build analysis
// topics) so these never drift apart — a symbol missing on the resolve side
// used to get stripped from winner_tickers/loser_tickers as if it were a stray
// stock ticker, silently and permanently orphaning the prediction (the coin
// symbol is not stored anywhere else).
//
// crypto.html's on-page coin grid keeps its own inline copy of the first 32 of
// these (presentation data, not save-path logic, so it can't cause the same
// data-loss bug) — worth eventually templating from this same source via
// scripts/build-www.sh, but not required for that to stay correct.
export const COIN_INFO = [
  { symbol: 'BTC',    name: 'Bitcoin' },
  { symbol: 'ETH',    name: 'Ethereum' },
  { symbol: 'SOL',    name: 'Solana' },
  { symbol: 'DOGE',   name: 'Dogecoin' },
  { symbol: 'XRP',    name: 'XRP' },
  { symbol: 'AVAX',   name: 'Avalanche' },
  { symbol: 'SHIB',   name: 'Shiba Inu' },
  { symbol: 'LINK',   name: 'Chainlink' },
  { symbol: 'POL',    name: 'Polygon' },
  { symbol: 'ADA',    name: 'Cardano' },
  { symbol: 'DOT',    name: 'Polkadot' },
  { symbol: 'NEAR',   name: 'NEAR Protocol' },
  { symbol: 'ATOM',   name: 'Cosmos' },
  { symbol: 'XLM',    name: 'Stellar' },
  { symbol: 'LTC',    name: 'Litecoin' },
  { symbol: 'ALGO',   name: 'Algorand' },
  { symbol: 'UNI',    name: 'Uniswap' },
  { symbol: 'AAVE',   name: 'Aave' },
  { symbol: 'MKR',    name: 'Maker' },
  { symbol: 'GRT',    name: 'The Graph' },
  { symbol: 'FIL',    name: 'Filecoin' },
  { symbol: 'HBAR',   name: 'Hedera' },
  { symbol: 'ETC',    name: 'Ethereum Classic' },
  { symbol: 'BCH',    name: 'Bitcoin Cash' },
  { symbol: 'OP',     name: 'Optimism' },
  { symbol: 'ARB',    name: 'Arbitrum' },
  { symbol: 'SUI',    name: 'Sui' },
  { symbol: 'APT',    name: 'Aptos' },
  { symbol: 'PEPE',   name: 'Pepe' },
  { symbol: 'BAT',    name: 'Basic Attention Token' },
  { symbol: 'MANA',   name: 'Decentraland' },
  { symbol: 'SAND',   name: 'The Sandbox' },
  { symbol: 'MATIC',  name: 'Polygon (old)' },
  { symbol: 'BNB',    name: 'BNB' },
  { symbol: 'TRX',    name: 'TRON' },
  { symbol: 'TON',    name: 'Toncoin' },
  { symbol: 'RENDER', name: 'Render' },
  { symbol: 'INJ',    name: 'Injective' },
  { symbol: 'WIF',    name: 'dogwifhat' },
  { symbol: 'BONK',   name: 'Bonk' },
  { symbol: 'JUP',    name: 'Jupiter' },
  { symbol: 'PYTH',   name: 'Pyth Network' },
];

export const COIN_SYMS = new Set(COIN_INFO.map(c => c.symbol));

// The most liquid, most consistently-covered coins — deep markets and steady
// news coverage make a real directional call more meaningful here than for
// the thinner, more sentiment/meme-driven long tail (PEPE, WIF, BONK, etc.).
// api/generate-baseline.js prioritizes generating for these first so they're
// never crowded out by long-tail coins if a day's generation budget runs
// short. This does NOT exempt them from the no-signal gate in api/analyze.js
// (runAnalysis) — even a core coin can have a genuinely quiet, low-signal
// day, and should say so rather than force a call.
export const CORE_COINS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'LINK', 'ADA']);

// Yahoo lists some coins under an id-suffixed symbol because the plain one is
// taken by an unrelated token (ARB-USD is "ARbit", TON-USD is "TON Token") or
// doesn't exist (SUI-USD, UNI-USD, ...). Using the plain symbol either failed
// grading outright or, worse, graded against the wrong coin's price. MATIC
// migrated to POL, so both map to the same listing. Verified 2026-10-10.
const YAHOO_COIN_OVERRIDES = {
  ARB: 'ARB11841', TON: 'TON11419', SUI: 'SUI20947', UNI: 'UNI7083',
  GRT: 'GRT6719', APT: 'APT21794', PEPE: 'PEPE24478', POL: 'POL28321', MATIC: 'POL28321',
};

// Raw ticker -> Yahoo symbol. Non-coin tickers pass through unchanged.
export function yahooSymbol(ticker) {
  if (!COIN_SYMS.has(ticker)) return ticker;
  return `${YAHOO_COIN_OVERRIDES[ticker] || ticker}-USD`;
}
