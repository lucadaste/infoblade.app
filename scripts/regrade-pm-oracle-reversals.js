// One-time correction: 3 specific prediction-market predictions whose stored
// grade disagrees with Polymarket's CURRENT live resolution data, found by
// the 2026-10 grading audit. For each, pickPmMarket/pmOutcome (the same
// functions api/predictions.js's resolver uses) were re-run against a fresh
// fetch of the market and returned the opposite Yes/No outcome from what's
// stored — all three in the same direction (stored incorrect, live correct).
// Checked by hand before writing this script: in each case the resolver
// picked the correct sub-market (an exact question-text match, not a
// mismatched one), and the market is currently umaResolutionStatus:
// 'resolved' with a clean (>=97%/<=3%) price — not an interim/ambiguous
// read. Most consistent explanation is a Polymarket/UMA dispute correction
// landing after InfoBlade's original grading pass ran.
//
// Deliberately NOT a general re-check of all PM predictions — only these 3
// specific, hand-verified ids. A general "trust whatever Polymarket says
// right now" pass would be wrong to run broadly (see pm-resolution.js's own
// comment on why a stale/interim price caused a false grade in production
// once already).
//
// Dry-run by default — prints what WOULD change. Pass --write to actually
// update the database.
//
// Usage: node scripts/regrade-pm-oracle-reversals.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { pickPmMarket, pmOutcome } from '../lib/pm-resolution.js';

const WRITE = process.argv.includes('--write');
const TARGET_IDS = ['pm_1790058646266_7566', 'pm_1789515035776_1647', 'pm_1789507917273_2272'];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

// Mirrors _pmScore/_pmGrade/_pmWeight in api/predictions.js exactly (not
// exported from there — kept as a one-time copy here, same rationale as
// the other regrade-*.js scripts in this directory).
function pmScore(correct, lean, marketOddsAtTime) {
  if (!correct) return -65;
  if (marketOddsAtTime == null || !lean) return 65;
  const pSide = lean === 'Yes' ? marketOddsAtTime : (100 - marketOddsAtTime);
  const edgeFraction = Math.max(0, Math.min(1, (85 - pSide) / 70));
  return +(65 + edgeFraction * 35).toFixed(1);
}
function pmGrade(correct) { return correct ? 'A' : 'F'; }

async function fetchPmEvent(slug) {
  const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const data = await r.json();
  return (Array.isArray(data) ? data[0] : data) || null;
}

async function main() {
  const supabase = getSupabase();
  const nowStr = new Date().toISOString();

  const { data: rows, error } = await supabase
    .from('predictions')
    .select('id, topic, lean, lean_confidence, market_slug, market_odds_at_time, correct, analysis')
    .in('id', TARGET_IDS);
  if (error) throw error;
  if (!rows?.length) { console.log('None of the target ids were found.'); return; }

  const updates = [];
  for (const pred of rows) {
    const event = pred.market_slug ? await fetchPmEvent(pred.market_slug) : null;
    if (!event) { console.log(`  ${pred.id}: SKIP — market_slug "${pred.market_slug}" no longer resolves`); continue; }
    const market = pickPmMarket(event, pred.topic);
    const outcome = pmOutcome(market);
    if (!outcome) { console.log(`  ${pred.id}: SKIP — market not cleanly resolved on a re-fetch right now`); continue; }

    const leanCorrect = pred.lean === outcome;
    if (leanCorrect === pred.correct) {
      console.log(`  ${pred.id}: no change needed — live data now agrees with stored grade (correct=${pred.correct})`);
      continue;
    }

    const newScore = pmScore(leanCorrect, pred.lean, pred.market_odds_at_time);
    console.log(`  ${pred.id} (${pred.topic}): correct ${pred.correct} -> ${leanCorrect}, resolved_outcome ${pred.analysis?.resolved_outcome} -> ${outcome}`);

    updates.push({
      id: pred.id,
      correct: leanCorrect,
      analysis: {
        ...(pred.analysis || {}),
        grade: pmGrade(leanCorrect),
        score: newScore,
        accuracy_score: newScore,
        resolved_outcome: outcome,
        // Traceable correction, not a silent overwrite — keeps what the
        // original grade said and why this changed (2026-10 grading audit).
        pre_correction_outcome: pred.analysis?.resolved_outcome ?? null,
        pre_correction_correct: pred.correct,
        corrected_at: nowStr,
        correction_note: 'Corrected by scripts/regrade-pm-oracle-reversals.js — live Polymarket resolution for this market reversed after InfoBlade\'s original grading pass (verified against a fresh fetch of the same sub-market, umaResolutionStatus: resolved, clean >=97%/<=3% price).',
      },
    });
  }

  if (!updates.length) { console.log('\nNothing to write.'); return; }

  if (!WRITE) {
    console.log(`\nDry run only — pass --write to apply these ${updates.length} updates to the database.`);
    return;
  }

  console.log(`\nWriting ${updates.length} updates...`);
  let written = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase.from('predictions')
      .update({ correct: u.correct, analysis: u.analysis })
      .eq('id', u.id);
    if (upErr) console.error(`  FAILED ${u.id}:`, upErr.message);
    else written++;
  }
  console.log(`Done. ${written}/${updates.length} rows updated.`);
}

main().catch(err => {
  console.error('[regrade-pm-oracle-reversals] failed:', err.message);
  process.exit(1);
});
