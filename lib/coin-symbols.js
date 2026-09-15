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
