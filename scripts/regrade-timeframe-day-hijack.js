// One-time cleanup for the "day"-before-"month"/"week" bug in
// lib/timeframe.js's parseTimeframeDays (fixed in the same commit as this
// script). A timeframe string like "Over the next 3 months (approximately
// 65 trading days)" used to match on the word "day" first, fail to extract a
// number from it, and silently fall back to the 7-day default — so a
// 3-month-horizon prediction got validation_date locked ~7 days out instead
// of ~90, and then graded the moment that week passed instead of waiting out
// its real window.
//
// This only affects stock/crypto predictions (lean IS NULL) — PM/market rows
// set impact_timeframe directly from the Polymarket close date, not from a
// free-text Claude string, so they were never exposed to this parser bug.
//
// For every lean-IS-NULL row with an impact_timeframe, recomputes the
// correct validation_date with the fixed parser and compares to what the old
// (inlined below, unfixed) parser would have produced. Only rows where the
// two disagree are touched:
//   - still pending (correct IS NULL): validation_date is corrected in place.
//   - already resolved, but the CORRECTED validation_date is still in the
//     future: the row was graded before its real window elapsed — reopened
//     (correct/status reset to pending, validation_date corrected, the old
//     grade's score/grade/ticker_moves stripped from analysis so the normal
//     resolve cron regrades it cleanly once the real window passes).
//   - already resolved, but the corrected validation_date has ALSO already
//     passed: the bug shortened the window, but real time caught up with the
//     correct window anyway before this script ran. Only the validation_date
//     bookkeeping field is corrected — the existing grade is left alone
//     rather than re-fetching price history for a window that already closed.
//
// Dry-run by default — prints what WOULD change. Pass --write to actually
// update the database.
//
// Usage: node scripts/regrade-timeframe-day-hijack.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { parseTimeframeDays } from '../lib/timeframe.js';

const WRITE = process.argv.includes('--write');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
}

// Exact copy of the pre-fix branch order (day/hour checked before week/month)
// — kept here only so this one-time script can detect which historical rows
// were actually affected. Not exported, not used anywhere else.
function oldBuggyParseTimeframeDays(str) {
  if (!str) return 30;
  const s = str.toLowerCase();
  const MAX_DAYS = 730;
  if (s.includes('hour')) {
    const h = s.match(/(\d+)/);
    return Math.max(1, Math.round((h ? +h[1] : 24) / 24));
  }
  if (s.includes('day')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*day/);
    if (range) return Math.min(Math.round((+range[1] + +range[2]) / 2), MAX_DAYS);
    const single = s.match(/(\d+)\s*day/);
    return Math.min(single ? +single[1] : 7, MAX_DAYS);
  }
  if (s.includes('week')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*week/);
    if (range) return Math.min(Math.round((+range[1] + +range[2]) / 2) * 7, MAX_DAYS);
    const single = s.match(/(\d+)\s*week/);
    return Math.min(single ? +single[1] * 7 : 14, MAX_DAYS);
  }
  if (s.includes('month')) {
    const range = s.match(/(\d+)[^\d]+(\d+)\s*month/);
    if (range) return Math.min(Math.round((+range[1] + +range[2]) / 2) * 30, MAX_DAYS);
    const single = s.match(/(\d+)\s*month/);
    return Math.min(single ? +single[1] * 30 : 30, MAX_DAYS);
  }
  return 30;
}

async function main() {
  const supabase = getSupabase();
  const nowMs = Date.now();

  const rows = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await supabase
      .from('predictions')
      .select('id, topic, created_at, validation_date, correct, status, analysis')
      .is('lean', null)
      .not('analysis->>impact_timeframe', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  console.log(`Scanning ${rows.length} stock/crypto predictions with an impact_timeframe...`);

  const toFixPending = [];
  const toReopen = [];
  const toRelabelOnly = [];

  for (const p of rows) {
    const tf = p.analysis?.impact_timeframe;
    if (!tf) continue;
    const oldDays = oldBuggyParseTimeframeDays(tf);
    const newDays = parseTimeframeDays(tf);
    if (oldDays === newDays) continue; // not affected by the bug

    const createdMs = new Date(p.created_at).getTime();
    const correctedValDate = new Date(createdMs + newDays * 86400000);
    const isResolved = p.correct !== null && p.correct !== undefined;

    if (!isResolved) {
      toFixPending.push({ p, tf, oldDays, newDays, correctedValDate });
    } else if (correctedValDate.getTime() > nowMs) {
      toReopen.push({ p, tf, oldDays, newDays, correctedValDate });
    } else {
      toRelabelOnly.push({ p, tf, oldDays, newDays, correctedValDate });
    }
  }

  console.log(`\nAffected: ${toFixPending.length + toReopen.length + toRelabelOnly.length}`);
  console.log(`  pending rows — validation_date will be corrected:        ${toFixPending.length}`);
  console.log(`  resolved too early — will be REOPENED for regrading:     ${toReopen.length}`);
  console.log(`  resolved, corrected window already elapsed too — date-only fix: ${toRelabelOnly.length}`);

  const sample = [...toFixPending, ...toReopen, ...toRelabelOnly].slice(0, 15);
  for (const { p, tf, oldDays, newDays, correctedValDate } of sample) {
    console.log(`  [${p.id}] "${p.topic}" — tf="${tf}" oldDays=${oldDays} newDays=${newDays} correctedValDate=${correctedValDate.toISOString().slice(0,10)} resolved=${p.correct !== null}`);
  }
  if (sample.length < toFixPending.length + toReopen.length + toRelabelOnly.length) {
    console.log(`  ... and ${toFixPending.length + toReopen.length + toRelabelOnly.length - sample.length} more`);
  }

  if (!WRITE) {
    console.log('\nDry run only — pass --write to apply changes.');
    return;
  }

  let updated = 0;
  for (const { p, correctedValDate } of toFixPending) {
    const { error } = await supabase.from('predictions')
      .update({ validation_date: correctedValDate.toISOString() })
      .eq('id', p.id);
    if (!error) updated++; else console.error(`  update failed for ${p.id}:`, error.message);
  }
  for (const { p, correctedValDate } of toReopen) {
    const strippedAnalysis = { ...(p.analysis || {}) };
    for (const k of ['grade', 'score', 'accuracy_score', 'outcome', 'raw_accuracy_score',
                      'raw_correct', 'raw_grade', 'scoring_version', 'confidence_weight', 'ticker_moves']) {
      delete strippedAnalysis[k];
    }
    const { error } = await supabase.from('predictions')
      .update({
        correct: null, status: 'pending', validated_at: null,
        validation_date: correctedValDate.toISOString(),
        actual_prices: null,
        analysis: strippedAnalysis,
      })
      .eq('id', p.id);
    if (!error) updated++; else console.error(`  reopen failed for ${p.id}:`, error.message);
  }
  for (const { p, correctedValDate } of toRelabelOnly) {
    const { error } = await supabase.from('predictions')
      .update({ validation_date: correctedValDate.toISOString() })
      .eq('id', p.id);
    if (!error) updated++; else console.error(`  update failed for ${p.id}:`, error.message);
  }

  console.log(`\nUpdated ${updated} rows.`);
}

main().catch(err => {
  console.error('[regrade-timeframe-day-hijack] failed:', err.message);
  process.exit(1);
});
