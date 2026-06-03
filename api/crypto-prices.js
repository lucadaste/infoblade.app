const CACHE_TTL = 60 * 1000; // 1 minute
let cache = { data: null, ts: 0 };

const COIN_IDS = [
  'bitcoin','ethereum','solana','dogecoin','ripple','avalanche-2','shiba-inu',
  'chainlink','matic-network','cardano','polkadot','near','cosmos','stellar',
  'litecoin','algorand','uniswap','aave','maker','the-graph','filecoin',
  'hedera-hashgraph','ethereum-classic','bitcoin-cash','optimism','arbitrum',
  'sui','aptos','pepe','basic-attention-token','decentraland','the-sandbox'
];

function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  try {
    const ids = COIN_IDS.join(',');
    const priceUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=100&sparkline=false&price_change_percentage=24h`;
    const fgUrl = 'https://api.alternative.me/fng/?limit=1';

    const headers = { 'Accept': 'application/json' };
    if (process.env.COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    }

    const [priceRes, fgRes] = await Promise.all([
      fetch(priceUrl, { headers }),
      fetch(fgUrl).catch(() => null)
    ]);

    if (!priceRes.ok) {
      return res.status(priceRes.status).json({ error: `CoinGecko returned ${priceRes.status}` });
    }

    const prices = await priceRes.json();
    if (!Array.isArray(prices)) {
      return res.status(502).json({ error: 'Unexpected response from CoinGecko' });
    }

    let fearGreed = null;
    if (fgRes?.ok) {
      const fgData = await fgRes.json().catch(() => null);
      fearGreed = fgData?.data?.[0] ?? null;
    }

    const result = { prices, fearGreed };
    cache = { data: result, ts: now };
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
