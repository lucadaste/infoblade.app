// Empirical Bayes calibration for lib/source-quality-priors.js: instead of
// hand-picking "High-grade sources are probably right 65% of the time," this
// reads every resolved prediction the platform has actually made and computes
// the REAL accuracy rate for each grade tier, plus (once there's enough
// distinct-source data) how much a tier's individual sources actually vary
// from each other — which sets the shrinkage "strength" itself instead of
// the fixed default.
//
// Read-only by default (prints a report). Pass --write to regenerate
// lib/source-quality-priors.js with the new numbers — a tier only gets
// overwritten once it has enough resolved data to trust; thin tiers keep
// their existing values and get flagged in the report as still pending.
//
// Usage: node scripts/calibrate-source-priors.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { staticSourceGrade } from '../lib/source-quality.js';
import { TIER_PRIORS as CURRENT_PRIORS } from '../lib/source-quality-priors.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WRITE = process.argv.includes('--write');
const TIERS = ['High', 'Medium', 'Low', 'Unknown'];

// A tier's empirical MEAN only overwrites the default once it has this many
// real citations behind it — otherwise a thin sample could swing the prior
// itself, defeating the point of shrinkage.
const MIN_ATTEMPTS_FOR_MEAN = 30;
// Estimating the shrinkage STRENGTH (how much sources within a tier actually
// vary from each other) needs enough distinct, individually-established
// sources, not just enough raw attempts pooled together.
const MIN_ATTEMPTS_PER_SOURCE_FOR_VARIANCE = 5;
const MIN_DISTINCT_SOURCES_FOR_VARIANCE = 5;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

async function main() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('predictions')
    .select('sources, source_grades, correct')
    .not('correct', 'is', null)
    .limit(5000);
  if (error) throw error;

  const tierTotals = Object.fromEntries(TIERS.map(t => [t, { attempts: 0, correct: 0 }]));
  const perSource = Object.fromEntries(TIERS.map(t => [t, new Map()]));

  let citationsWithSavedGrade = 0;
  let citationsRecomputed = 0;

  for (const row of data || []) {
    const sources = row.sources || [];
    for (const src of sources) {
      // Stock/crypto predictions saved the grade each source actually had at
      // analysis time (source_grades). Prediction-market rows never saved
      // this, so we fall back to today's static lookup — a reasonable but
      // not perfectly faithful stand-in, since the dictionary could have
      // changed since that row was written.
      let grade;
      if (row.source_grades && row.source_grades[src]) {
        grade = row.source_grades[src];
        citationsWithSavedGrade++;
      } else {
        grade = staticSourceGrade(src);
        citationsRecomputed++;
      }
      if (!TIERS.includes(grade)) continue;

      const t = tierTotals[grade];
      t.attempts++;
      if (row.correct) t.correct++;

      const m = perSource[grade];
      const entry = m.get(src) || { attempts: 0, correct: 0 };
      entry.attempts++;
      if (row.correct) entry.correct++;
      m.set(src, entry);
    }
  }

  console.log(`Resolved predictions scanned: ${data.length}`);
  console.log(`Source citations: ${citationsWithSavedGrade} with a saved grade, ${citationsRecomputed} recomputed via today's static dictionary (prediction-market rows, which don't persist per-source grades).\n`);

  const newPriors = {};
  for (const tier of TIERS) {
    const t = tierTotals[tier];
    const current = CURRENT_PRIORS[tier];
    const empiricalMean = t.attempts > 0 ? t.correct / t.attempts : null;
    const meanTrusted = t.attempts >= MIN_ATTEMPTS_FOR_MEAN;

    console.log(`${tier}:`);
    console.log(`  citations: ${t.attempts}, correct: ${t.correct}${empiricalMean != null ? `, empirical accuracy: ${(empiricalMean * 100).toFixed(1)}%` : ''}`);
    console.log(`  current prior: mean=${current.mean}, strength=${current.strength}`);

    let mean = current.mean;
    if (meanTrusted) {
      mean = +empiricalMean.toFixed(3);
      console.log(`  -> enough data (${t.attempts} >= ${MIN_ATTEMPTS_FOR_MEAN}): mean would update to ${mean}`);
    } else {
      console.log(`  -> not enough data yet (${t.attempts} < ${MIN_ATTEMPTS_FOR_MEAN}): keeping default mean ${mean}`);
    }

    // Strength (how much individual sources vary within the tier), via
    // method-of-moments Beta fit on distinct sources' own accuracy rates.
    let strength = current.strength;
    const rates = [...perSource[tier].values()]
      .filter(e => e.attempts >= MIN_ATTEMPTS_PER_SOURCE_FOR_VARIANCE)
      .map(e => e.correct / e.attempts);
    let strengthTrusted = false;
    if (rates.length >= MIN_DISTINCT_SOURCES_FOR_VARIANCE) {
      const m = rates.reduce((a, b) => a + b, 0) / rates.length;
      const variance = rates.reduce((a, b) => a + (b - m) ** 2, 0) / (rates.length - 1);
      if (variance > 0 && variance < m * (1 - m)) {
        const fitted = m * (1 - m) / variance - 1;
        // Clamp to a sane range — a fitted strength of, say, 2 or 5000 almost
        // certainly means too few/noisy samples for this method-of-moments
        // fit to be trustworthy, not that the true value is that extreme.
        strength = Math.round(Math.max(5, Math.min(200, fitted)));
        strengthTrusted = true;
        console.log(`  -> ${rates.length} distinct sources with enough individual history: strength would update to ${strength} (fitted ${fitted.toFixed(1)})`);
      } else {
        console.log(`  -> ${rates.length} distinct sources found, but the variance fit was out of range — keeping default strength ${strength}`);
      }
    } else {
      console.log(`  -> not enough distinct established sources yet (${rates.length} < ${MIN_DISTINCT_SOURCES_FOR_VARIANCE}): keeping default strength ${strength}`);
    }
    console.log('');

    newPriors[tier] = {
      mean,
      strength,
      _updated: meanTrusted || strengthTrusted,
    };
  }

  if (!WRITE) {
    console.log('Dry run only — pass --write to regenerate lib/source-quality-priors.js with the values above.');
    return;
  }

  const anyUpdated = TIERS.some(t => newPriors[t]._updated);
  if (!anyUpdated) {
    console.log('Nothing had enough data to update — leaving lib/source-quality-priors.js unchanged.');
    return;
  }

  const sampleSizes = Object.fromEntries(TIERS.map(t => [t, tierTotals[t].attempts]));
  const fileContent = `/**
 * Prior parameters for the Beta-Binomial shrinkage in lib/source-quality.js —
 * regenerated by scripts/calibrate-source-priors.js --write from real
 * resolved-prediction data. Do not hand-edit the numbers below; re-run the
 * script instead so they stay traceable to an actual calibration run. See
 * that script and lib/source-quality.js's betaShrunkAccuracy() for how these
 * are used.
 */
export const TIER_PRIORS = {
  High:    { mean: ${newPriors.High.mean}, strength: ${newPriors.High.strength} },
  Medium:  { mean: ${newPriors.Medium.mean}, strength: ${newPriors.Medium.strength} },
  Low:     { mean: ${newPriors.Low.mean}, strength: ${newPriors.Low.strength} },
  Unknown: { mean: ${newPriors.Unknown.mean}, strength: ${newPriors.Unknown.strength} },
};

// Regenerated by scripts/calibrate-source-priors.js --write.
export const _meta = {
  calibratedAt: ${JSON.stringify(new Date().toISOString())},
  sampleSizes: ${JSON.stringify(sampleSizes)},
};
`;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(__dirname, '..', 'lib', 'source-quality-priors.js');
  fs.writeFileSync(outPath, fileContent);
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('[calibrate-source-priors] failed:', err.message);
  process.exit(1);
});
