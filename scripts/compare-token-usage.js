// Read-only: does the category-aware prediction-market sourcing pipeline
// (lib/market-source-profiles.js) use more or fewer tokens per prompt than the
// old generic Google-News-+-Reddit pipeline it replaced?
//
// Unlike compare-sourcing-versions.js, this is a PAIRED live measurement, not a
// historical DB read: for each sampled real current market, it builds the "Recent
// news" (+ "Official/structured data") prompt section BOTH ways — via
// fetchLegacyGeneric (old) and via CATEGORY_SOURCE_PROFILES (new) — on the same
// question, at the same moment. That removes the before/after time-window
// confound entirely, and needs no Claude API calls (prompt size is known before
// Claude is ever invoked), so it produces a real result immediately instead of
// waiting on weeks of grading.
//
// Token counts are approximated as chars/4 (no tokenizer library is added just
// for this internal tool) — good enough to detect a real, consistent difference,
// but the absolute numbers shouldn't be quoted as exact token costs. Reputation-
// based "empirical" enrichment (api/market-analyze.js reads a live Supabase
// source_reputation table for this) is intentionally omitted on both sides here,
// so the comparison stays apples-to-apples without needing a DB connection.
//
// Usage: node scripts/compare-token-usage.js
// No environment variables required — samples real current Polymarket markets
// directly and makes no writes anywhere.

import { fetchCategoryMarkets } from '../api/markets.js';
import { getSourceGrade } from '../api/market-analyze.js';
import { CATEGORY_SOURCE_PROFILES, allocateBudget, fetchLegacyGeneric } from '../lib/market-source-profiles.js';
import { pairedDifferenceTest } from '../lib/stats.js';

const SAMPLE_PER_CATEGORY = 10;
const PM_CATEGORIES = ['sports', 'politics', 'finance', 'entertainment', 'tech'];

function approxTokens(s) {
  return Math.round(s.length / 4);
}

function buildOldSection(legacy) {
  const items = legacy.items.map(i => ({ ...i, grade: getSourceGrade(i.source) }));
  const news = items.length
    ? `Recent news (${items.length} articles):\n${items.map(i => `- "${i.title}" — ${i.source} [${i.grade}]`).join('\n')}`
    : '';
  const reddit = legacy.redditPosts.length
    ? `\nPublic sentiment on Reddit (${legacy.redditPosts.length} posts):\n${legacy.redditPosts.map(p => `- "${p}"`).join('\n')}`
    : '';
  return news + reddit;
}

async function buildNewSection(question, category, sport) {
  const profile = CATEGORY_SOURCE_PROFILES[category];
  const entities = profile.buildQuery(question, sport);
  const results = await Promise.allSettled(profile.fetchers.map(f => f(question, entities)));
  let fetched = [];
  for (const r of results) if (r.status === 'fulfilled') fetched.push(...r.value);

  const keywords = [
    ...(entities.teams || []).map(t => t.full),
    ...(entities.players || []),
    ...(entities.entities || []),
  ].filter(Boolean);
  if (keywords.length) {
    fetched = fetched.filter(i =>
      i.class !== 'news' ||
      i.sourceType === 'beat_reporter_news' ||
      keywords.some(k => i.title.toLowerCase().includes(k.toLowerCase()))
    );
  }
  fetched = fetched.map(i => ({ ...i, grade: i.grade || getSourceGrade(i.source) }));
  const allocated = allocateBudget(fetched);

  const structuredItems = allocated.filter(i => i.class === 'structured');
  const items = allocated.filter(i => i.class === 'news');
  const redditPosts = allocated.filter(i => i.class === 'reddit').map(i => i.title);

  const news = items.length
    ? `Recent news (${items.length} articles):\n${items.map(i => `- "${i.title}" — ${i.source} [${i.grade}${i.coverageVolume > 1 ? `, ${i.coverageVolume}x coverage` : ''}]`).join('\n')}`
    : '';
  const structured = structuredItems.length
    ? `\nOfficial/structured data (${structuredItems.length} items):\n${structuredItems.map(i => `- [${i.sourceType}] ${i.title}`).join('\n')}`
    : '';
  const reddit = redditPosts.length
    ? `\nPublic sentiment on Reddit (${redditPosts.length} posts):\n${redditPosts.map(p => `- "${p}"`).join('\n')}`
    : '';
  return news + structured + reddit;
}

async function main() {
  const perCategory = await Promise.all(PM_CATEGORIES.map(cat => fetchCategoryMarkets(cat, {}).catch(() => [])));

  const samples = [];
  for (let i = 0; i < PM_CATEGORIES.length; i++) {
    const cat = PM_CATEGORIES[i];
    for (const m of (perCategory[i] || []).slice(0, SAMPLE_PER_CATEGORY)) {
      samples.push({ category: cat, question: m.question || m.title, sport: m.sport || null });
    }
  }

  console.log(`Sampled ${samples.length} real current markets across ${PM_CATEGORIES.length} categories.\n`);

  const results = [];
  for (const s of samples) {
    if (!s.question) continue;
    const [legacy, newSection] = await Promise.all([
      fetchLegacyGeneric(s.question),
      buildNewSection(s.question, s.category, s.sport),
    ]);
    const oldSection = buildOldSection(legacy);
    const oldTokens = approxTokens(oldSection);
    const newTokens = approxTokens(newSection);
    results.push({ category: s.category, oldTokens, newTokens, diff: newTokens - oldTokens });
  }

  function report(label, rows) {
    console.log(`\n${label}`);
    if (!rows.length) { console.log('  no samples'); return; }
    const avgOld = Math.round(rows.reduce((a, r) => a + r.oldTokens, 0) / rows.length);
    const avgNew = Math.round(rows.reduce((a, r) => a + r.newTokens, 0) / rows.length);
    console.log(`  n=${rows.length}  avg old: ~${avgOld} tokens  avg new: ~${avgNew} tokens`);
    const test = pairedDifferenceTest(rows.map(r => r.diff));
    if (!test) {
      console.log(`  verdict: not enough data yet (need >= 20 paired samples)`);
      return;
    }
    const direction = test.meanDiff < 0 ? 'reduction' : test.meanDiff > 0 ? 'increase' : 'no change';
    console.log(`  mean difference: ${test.meanDiff.toFixed(1)} tokens  p-value: ${test.pValue.toFixed(4)}`);
    console.log(`  verdict: ${test.significant ? `statistically significant ${direction} (p<0.05)` : 'no statistically significant difference'}`);
  }

  report('OVERALL (all PM categories combined)', results);
  for (const cat of PM_CATEGORIES) {
    report(cat, results.filter(r => r.category === cat));
  }
}

main().catch(err => {
  console.error('[compare-token-usage] failed:', err.message);
  process.exit(1);
});
