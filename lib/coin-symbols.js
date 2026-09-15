// Canonical set of crypto ticker symbols the platform recognizes for crypto-coin
// predictions. Shared between api/analyze.js (creates predictions) and
// api/predictions.js (resolves/cleans them up) so the two never drift apart —
// a symbol missing here on the resolve side used to get stripped from
// winner_tickers/loser_tickers as if it were a stray stock ticker, silently and
// permanently orphaning the prediction (the coin symbol is not stored anywhere else).
export const COIN_SYMS = new Set([
  'BTC','ETH','SOL','DOGE','XRP','AVAX','SHIB','LINK','POL','ADA','DOT','NEAR',
  'ATOM','XLM','LTC','ALGO','UNI','AAVE','MKR','GRT','FIL','HBAR','ETC','BCH',
  'OP','ARB','SUI','APT','PEPE','BAT','MANA','SAND','MATIC','BNB','TRX','TON',
  'RENDER','INJ','WIF','BONK','JUP','PYTH',
]);
