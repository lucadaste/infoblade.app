import { runAnalysis } from './analyze.js';
import { runMarketAnalysis } from './market-analyze.js';
import { fetchCategoryMarkets, labelMarkets } from './markets.js';
import { SECTOR_STOCKS } from './sector-stocks.js';
import { COIN_INFO, CORE_COINS } from '../lib/coin-symbols.js';
import { categoryToSection } from '../lib/prediction-sections.js';
import { getSupabase, secretMatches } from '../lib/http.js';

// ── Daily baseline prediction generator ────────────────────────────────────────
// Runs on a cron independent of user traffic so the accuracy dashboard reflects
// all three sections, not mostly stocks. Each run tops up whichever sections are
// still under today's target with a small batch of not-yet-covered-today
// candidates, using the exact same analyze+save pipelines real predictions go
// through (runAnalysis / runMarketAnalysis). A section with no fresh candidates
// left for the day (crypto's ~42-coin universe, or few confident PM leads) is
// simply skipped for the rest of the day — never padded to force the target.

const DAILY_TARGET = parseInt(process.env.BASELINE_DAILY_TARGET, 10) || 50;
const BATCH_SIZE    = parseInt(process.env.BASELINE_BATCH_SIZE, 10) || 3;
const CONCURRENCY    = 3;

// Prediction markets get their own, larger budget: there are hundreds of live
// markets (vs a fixed stock/coin universe) and most resolve within weeks, so
// they're the fastest way to grow the graded track record.
const PM_DAILY_TARGET = parseInt(process.env.BASELINE_PM_DAILY_TARGET, 10) || 150;
const PM_BATCH_SIZE   = parseInt(process.env.BASELINE_PM_BATCH_SIZE, 10) || 6;
// Don't re-predict a market the platform already called within this window —
// a 30-day market predicted daily would otherwise count as ~30 correlated
// outcomes and crowd out markets that have never been covered.
const PM_REPEAT_COOLDOWN_DAYS = parseInt(process.env.BASELINE_PM_COOLDOWN_DAYS, 10) || 3;
const PM_BROWSE_PAGES = 5;   // 100 events per page, by 24h volume
const PM_PER_CATEGORY = 60;

// 'other' catches Polymarket events whose tags don't match any of the 5 named
// categories (science, weather, world events, etc.) — see api/markets.js's
// comment on 'other' for why this was previously invisible to the generator.
const PM_CATEGORIES = ['sports', 'politics', 'finance', 'entertainment', 'tech', 'other'];

// Same 4 horizons crypto.html's timeframe picker offers, weighted toward
// shorter ones: graded results (and the dashboard) fill in sooner, while
// longer horizons still get picked occasionally for realistic variety.
const TIMEFRAMES = [
  { context: 'over the next 24 hours', validationTimeframe: '1 day',   weight: 0.4 },
  { context: 'over the next 1-7 days', validationTimeframe: '7 days',  weight: 0.3 },
  { context: 'over the next 30 days',  validationTimeframe: '30 days', weight: 0.2 },
  { context: 'over the next 3 months', validationTimeframe: '90 days', weight: 0.1 },
];

// Stocks only trade Mon-Fri. A "1 day" validation window created on a Friday
// or Saturday spans zero real trading days before it gets checked (Fri->Sat
// and Sat->Sun both land entirely inside the weekend, with no new closing
// price posted in between) — the resolver then compares a price against
// itself, reads that as "didn't move," and grades it wrong regardless of
// what was actually predicted. Confirmed directly: every affected 1-star
// stock prediction traced back to exactly this (see
// scripts/diagnose-direction-bias.js). Sunday through Thursday creation
// always has at least one real trading day before a 1-day check-back, so
// only these two starting days need to skip the option. Crypto trades 24/7
// and never hits this, so it always keeps the full distribution.
function _stockOneDayHorizonIsSafe() {
  const day = new Date().getUTCDay(); // 0=Sun ... 5=Fri, 6=Sat
  return day !== 5 && day !== 6;
}

function _pickTimeframe(allowOneDay = true) {
  const r = Math.random();
  let cum = 0;
  for (const tf of TIMEFRAMES) {
    cum += tf.weight;
    if (r < cum) return (!allowOneDay && tf.validationTimeframe === '1 day') ? TIMEFRAMES[1] : tf;
  }
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

// A few index/ETF tickers in SECTOR_STOCKS['any'] aren't in SEC's company list.
const STOCK_NAME_FALLBACKS = {
  SPX: 'S&P 500 Index', QQQ: 'Invesco QQQ Trust', IWM: 'iShares Russell 2000 ETF',
  SQ: 'Block, Inc.', TLT: 'iShares 20+ Year Treasury Bond ETF',
  XLE: 'Energy Select Sector SPDR Fund', XLF: 'Financial Select Sector SPDR Fund',
  XLK: 'Technology Select Sector SPDR Fund', XLV: 'Health Care Select Sector SPDR Fund',
  GDX: 'VanEck Gold Miners ETF', VNQ: 'Vanguard Real Estate ETF',
  HYG: 'iShares iBoxx High Yield Corporate Bond ETF',
};

// Same SEC company list feed.html's ticker search and api/tickers.js use, so
// baseline stock topics read the same as organic ones ("Apple Inc. (AAPL)...").
let _stockNames = null;
async function _getStockNames() {
  if (_stockNames) return _stockNames;
  const map = { ...STOCK_NAME_FALLBACKS };
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'InvestmentInformatics.AI contact@infoblade.app', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    for (const c of Object.values(data)) {
      const sym = String(c.ticker).toUpperCase();
      if (!map[sym]) map[sym] = String(c.title);
    }
  } catch (_) { /* fall back to tickers-as-names for anything missing */ }
  _stockNames = map;
  return map;
}

async function _runBatch(items, concurrency, fn) {
  let idx = 0;
  const out = [];
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i]); }
      catch (err) { out[i] = { error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function _todaysBaselineState(supabase) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('predictions')
    .select('category, lean, winner_tickers, loser_tickers, market_slug')
    .eq('analysis->>baseline_generated', 'true')
    .gte('created_at', startOfDay.toISOString());
  if (error) throw error;

  const counts = { stocks: 0, crypto: 0, 'prediction-markets': 0 };
  const coveredTickers = new Set();
  const coveredCoins    = new Set();

  for (const p of data || []) {
    const section = p.lean ? 'prediction-markets' : categoryToSection(p.category || 'any');
    counts[section] = (counts[section] || 0) + 1;
    const tickers = [...(p.winner_tickers || []), ...(p.loser_tickers || [])];
    if (section === 'stocks') tickers.forEach(t => coveredTickers.add(t));
    if (section === 'crypto') tickers.forEach(t => coveredCoins.add(t));
  }

  // Any market predicted within the cooldown — baseline or user-triggered.
  const coveredSlugs = new Set();
  const since = new Date(Date.now() - PM_REPEAT_COOLDOWN_DAYS * 86400000).toISOString();
  for (let from = 0; from < 20000; from += 1000) {
    const { data: rows, error: slugErr } = await supabase
      .from('predictions')
      .select('market_slug')
      .not('market_slug', 'is', null)
      .gte('created_at', since)
      .range(from, from + 999);
    if (slugErr) throw slugErr;
    for (const r of rows || []) coveredSlugs.add(r.market_slug);
    if (!rows || rows.length < 1000) break;
  }
  // Close calls are saved to pm_briefings instead (api/market-analyze.js) —
  // cool those down too, or the same near-50/50 markets get re-analyzed daily.
  // Tolerates the table not existing yet (schema migration not run).
  for (let from = 0; from < 20000; from += 1000) {
    const { data: rows, error: briefErr } = await supabase
      .from('pm_briefings')
      .select('market_slug')
      .not('market_slug', 'is', null)
      .gte('created_at', since)
      .range(from, from + 999);
    if (briefErr) break;
    for (const r of rows || []) coveredSlugs.add(r.market_slug);
    if (!rows || rows.length < 1000) break;
  }

  return { counts, coveredTickers, coveredCoins, coveredSlugs };
}

// Weighted sample without replacement, favoring markets that end soon so their
// grades land on the dashboard within days. Random rather than top-N: an
// "Uncertain" lean isn't saved, so a fixed ordering re-picked the same few
// undecidable markets every run and stalled the section for the whole day.
function _sampleMarkets(markets, n) {
  const weightOf = m => (m.daysLeft != null && m.daysLeft <= 7) ? 4 : (m.daysLeft != null && m.daysLeft <= 30) ? 2 : 1;
  const pool = markets.map(m => ({ m, w: weightOf(m) }));
  const out = [];
  while (out.length < n && pool.length) {
    let r = Math.random() * pool.reduce((sum, x) => sum + x.w, 0);
    let i = 0;
    while ((r -= pool[i].w) > 0 && i < pool.length - 1) i++;
    out.push(pool.splice(i, 1)[0].m);
  }
  return out;
}

async function _generateStocks(supabase, remaining, coveredTickers) {
  const candidates = SECTOR_STOCKS['any'].filter(t => !coveredTickers.has(t)).slice(0, Math.min(remaining, BATCH_SIZE));
  if (!candidates.length) return { attempted: 0, saved: 0 };

  const names = await _getStockNames();
  const allowOneDay = _stockOneDayHorizonIsSafe();
  const results = await _runBatch(candidates, CONCURRENCY, async ticker => {
    const name = names[ticker] || ticker;
    const tf = _pickTimeframe(allowOneDay);
    return runAnalysis({
      supabase,
      topic: `${name} (${ticker}) stock market outlook ${tf.context}`,
      headlines: [], sources: [], sourceGrades: {}, minGrade: 'all',
      category: 'any', impactTimeframe: tf.validationTimeframe,
      baselineGenerated: true,
    });
  });

  return { attempted: candidates.length, saved: results.filter(r => r?.predictionSaved).length };
}

async function _generateCrypto(supabase, remaining, coveredCoins) {
  // Core coins (deep markets, steady coverage — see lib/coin-symbols.js) go first,
  // so they're never crowded out by the long tail if a run's budget is tight.
  const candidates = COIN_INFO
    .filter(c => !coveredCoins.has(c.symbol))
    .sort((a, b) => (CORE_COINS.has(b.symbol) ? 1 : 0) - (CORE_COINS.has(a.symbol) ? 1 : 0))
    .slice(0, Math.min(remaining, BATCH_SIZE));
  if (!candidates.length) return { attempted: 0, saved: 0 };

  const results = await _runBatch(candidates, CONCURRENCY, async coin => {
    const tf = _pickTimeframe();
    return runAnalysis({
      supabase,
      topic: `${coin.name} (${coin.symbol}) cryptocurrency market outlook ${tf.context}`,
      headlines: [], sources: [], sourceGrades: {}, minGrade: 'all',
      category: 'crypto-coin', coinSymbol: coin.symbol, impactTimeframe: tf.validationTimeframe,
      baselineGenerated: true,
    });
  });

  return { attempted: candidates.length, saved: results.filter(r => r?.predictionSaved).length };
}

async function _generatePredictionMarkets(supabase, remaining, coveredSlugs) {
  const perCategory = await Promise.all(
    PM_CATEGORIES.map(cat => fetchCategoryMarkets(cat, { pages: PM_BROWSE_PAGES, limit: PM_PER_CATEGORY, labels: false }).catch(() => []))
  );
  const seen = new Set();
  const candidates = [];
  for (const list of perCategory) {
    for (const m of list) {
      if (!m.slug || seen.has(m.slug) || coveredSlugs.has(m.slug)) continue;
      seen.add(m.slug);
      candidates.push(m);
    }
  }
  // Legitimacy-check only the sampled batch (one small Haiku call) rather than
  // labeling the whole several-hundred-market pool every run.
  const batch = await labelMarkets(_sampleMarkets(candidates, Math.min(remaining, PM_BATCH_SIZE)));
  if (!batch.length) return { attempted: 0, saved: 0, pool: candidates.length };

  const results = await _runBatch(batch, PM_BATCH_SIZE, async market => {
    return runMarketAnalysis({
      supabase,
      question: market.question || market.title,
      currentOdds: market.yesPrice,
      marketCategory: market.category,
      slug: market.slug,
      daysLeft: market.daysLeft,
      sport: market.sport,
      baselineGenerated: true,
    });
  });

  return { attempted: batch.length, saved: results.filter(r => r?.predictionSaved).length, pool: candidates.length };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const cronSecret   = process.env.CRON_SECRET;
  const manualSecret = process.env.VALIDATE_SECRET;
  const authHeader    = req.headers['authorization'];
  // Header only — a ?secret= query param would end up in access logs.
  const manualToken   = req.headers['x-validate-secret'];

  const isCron   = !!cronSecret   && secretMatches(authHeader, `Bearer ${cronSecret}`);
  const isManual = !!manualSecret && secretMatches(manualToken, manualSecret);
  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  let supabase;
  try { supabase = getSupabase({ required: true }); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  try {
    const { counts, coveredTickers, coveredCoins, coveredSlugs } = await _todaysBaselineState(supabase);

    const met = { attempted: 0, saved: 0, note: 'target already met today' };

    // Run all 3 sections concurrently — sequentially, each section's Claude
    // calls alone can approach the 60s function budget, and three in a row
    // reliably blew through it (504 FUNCTION_INVOCATION_TIMEOUT in practice).
    const [stocks, crypto, predictionMarkets] = await Promise.all([
      counts.stocks < DAILY_TARGET
        ? _generateStocks(supabase, DAILY_TARGET - counts.stocks, coveredTickers)
        : Promise.resolve(met),
      counts.crypto < DAILY_TARGET
        ? _generateCrypto(supabase, DAILY_TARGET - counts.crypto, coveredCoins)
        : Promise.resolve(met),
      counts['prediction-markets'] < PM_DAILY_TARGET
        ? _generatePredictionMarkets(supabase, PM_DAILY_TARGET - counts['prediction-markets'], coveredSlugs)
        : Promise.resolve(met),
    ]);

    const summary = {
      target: DAILY_TARGET,
      pmTarget: PM_DAILY_TARGET,
      before: counts,
      sections: { stocks, crypto, 'prediction-markets': predictionMarkets },
    };

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[generate-baseline]', err.message);
    return res.status(500).json({ error: 'Baseline generation failed', detail: err.message });
  }
}
