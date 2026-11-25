// Builds the pattern-library history: for every S&P 500 stock and tracked
// coin, pulls ~8 years of daily bars from Yahoo, finds price/volume events
// (lib/patterns.js) and records what each ticker did vs its benchmark (SPY or
// BTC) over the next 1, 5 and 20 bars.
//
// Writes one JSON file per ticker to --out (default data/pattern-cache/), so
// it's resumable: tickers that already have a file are skipped unless --fresh.
// Reads only public Yahoo data; needs no keys and writes nothing to Supabase.
// Next step: node scripts/test-patterns.js
//
// Usage: node scripts/backfill-pattern-events.js [--years=8] [--limit=20]
//          [--tickers=AAPL,NVDA,ETH] [--out=data/pattern-cache] [--fresh]
//
// Known bias: the stock list is TODAY's S&P 500, so companies that fell out
// of the index (often after big drops) are missing. test-patterns.js prints
// this caveat with its results.

import fs from 'node:fs';
import path from 'node:path';
import { fetchYahooChartSeries } from '../lib/yahoo-chart.js';
import { SP500_TICKERS } from '../lib/sp500-tickers.js';
import { COIN_INFO, COIN_SYMS } from '../lib/coin-symbols.js';
import { STOCK_BENCHMARK, CRYPTO_BENCHMARK } from '../lib/benchmarks.js';
import { cleanSeries, buildEventRows, PATTERN_VERSION } from '../lib/patterns.js';

const CONCURRENCY = 4;
const PAUSE_MS = 250;   // between requests per worker; Yahoo rate-limits bursts

function arg(name, fallback) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : fallback;
}
const flag = name => process.argv.includes(`--${name}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const years = Number(arg('years', 8));
const outDir = arg('out', 'data/pattern-cache');
const fresh = flag('fresh');
const period2 = Math.floor(Date.now() / 1000);
const period1 = period2 - Math.round(years * 365.25 * 86400);

async function fetchSeries(ticker) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await fetchYahooChartSeries(ticker, period1, period2, { timeoutMs: 20000 });
    if (s) return cleanSeries(s);
    await sleep(1500 * (attempt + 1));
  }
  return null;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  let universe;
  if (arg('tickers')) universe = arg('tickers').split(',').map(t => t.trim().toUpperCase());
  else {
    universe = [...SP500_TICKERS, ...COIN_INFO.map(c => c.symbol)];
    universe = universe.filter(t => t !== STOCK_BENCHMARK && t !== CRYPTO_BENCHMARK);
  }
  if (arg('limit')) universe = universe.slice(0, Number(arg('limit')));

  const benches = {};
  for (const b of [STOCK_BENCHMARK, CRYPTO_BENCHMARK]) {
    const s = await fetchSeries(b);
    if (!s) throw new Error(`Could not fetch benchmark ${b}; stopping (alpha would be wrong).`);
    benches[b] = new Map(s.dates.map((d, i) => [d, s.closes[i]]));
  }

  const todo = universe.filter(t => fresh || !fs.existsSync(path.join(outDir, `${t}.json`)));
  console.log(`${universe.length} tickers, ${universe.length - todo.length} already cached, fetching ${todo.length} (${years}y of daily bars)`);

  let done = 0, failed = [];
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const ticker = todo[next++];
      const assetClass = COIN_SYMS.has(ticker) ? 'crypto' : 'stock';
      const series = await fetchSeries(ticker);
      if (!series || series.closes.length < 300) {
        failed.push(ticker);
      } else {
        const bench = benches[assetClass === 'crypto' ? CRYPTO_BENCHMARK : STOCK_BENCHMARK];
        const { events, base } = buildEventRows(series, bench, { assetClass });
        fs.writeFileSync(path.join(outDir, `${ticker}.json`), JSON.stringify({
          version: PATTERN_VERSION, ticker, assetClass,
          from: series.dates[0], to: series.dates.at(-1), bars: series.closes.length,
          events, base,
        }));
      }
      done++;
      if (done % 25 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}`);
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed.length) console.log(`Skipped ${failed.length} (no data or under 300 bars): ${failed.join(', ')}`);
  console.log(`Done. Next: node scripts/test-patterns.js --dir=${outDir}`);
}

main().catch(err => { console.error(err); process.exit(1); });
