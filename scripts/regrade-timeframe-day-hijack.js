// One-time cleanup for parseTimeframeDays bugs in lib/timeframe.js — first
// the original "day"-before-"month"/"week" branch order (a string like
// "Over the next 3 months (approximately 65 trading days)" matched on "day"
// first and fell back to a 7-day default), then a regression introduced
// while fixing that: an unbounded range regex ((\d+)[^\d]+(\d+)\s*unit) let
// two numbers from unrelated clauses get paired as a fake range (e.g.
// "Immediate within 48 hours through 1 month" read 48 and 1 as a "48 to 1
// months" range — avg 24.5 rounds to 25 months, 730 days, instead of the ~2
// days the sentence actually means). That regression round-tripped through
// this script's own --write once, so some rows in the DB right now hold a
// validation_date computed by a parser that was itself buggy at the time.
//
// Rather than re-deriving "what the old buggy parser would have produced"
// (which only catches rows the CURRENTLY-fixed parser disagrees with
// relative to one specific prior bug, and would miss damage from a
// different prior bug), this compares the CURRENTLY STORED validation_date
// against what today's parseTimeframeDays produces right now. That makes it
// correct regardless of which bug (if any) produced the stored value, and
// safe to rerun after any future parser fix — a clean run finds 0 rows.
//
// This only affects stock/crypto predictions (lean IS NULL) — PM/market rows
// set impact_timeframe directly from the Polymarket close date, not from a
// free-text Claude string, so they were never exposed to this parser.
//
// Only rows whose stored validation_date differs from today's correct parse
// by more than a day are touched:
//   - still pending (correct IS NULL): validation_date is corrected in place.
//   - already resolved, but the CORRECTED validation_date is still in the
//     future: the row was graded before its real window elapsed — reopened
//     (correct/status reset to pending, validation_date corrected, the old
//     grade's score/grade/ticker_moves stripped from analysis so the normal
//     resolve cron regrades it cleanly once the real window passes).
//   - already resolved, but the corrected validation_date has ALSO already
//     passed: real time caught up with the correct window anyway before this
//     script ran. Only the validation_date bookkeeping field is corrected —
//     the existing grade is left alone rather than re-fetching price history
//     for a window that already closed.
//
// Dry-run by default — prints what WOULD change. Pass --write to actually
// update the database.
//
// Usage: node scripts/regrade-timeframe-day-hijack.js [--write]
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

import { createClient } from '@supabase/supabase-js';
import { parseTimeframeDays } from '../lib/timeframe.js';

const WRITE = process.argv.includes('--write');
const DIFF_THRESHOLD_MS = 1 * 86400000; // ignore sub-day drift (rounding noise)

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars required');
  return createClient(url, key);
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
    const correctDays = parseTimeframeDays(tf);
    const createdMs = new Date(p.created_at).getTime();
    const correctedValDate = new Date(createdMs + correctDays * 86400000);

    const storedMs = p.validation_date ? new Date(p.validation_date).getTime() : null;
    if (storedMs != null && Math.abs(storedMs - correctedValDate.getTime()) <= DIFF_THRESHOLD_MS) continue;

    const isResolved = p.correct !== null && p.correct !== undefined;

    if (!isResolved) {
      toFixPending.push({ p, tf, correctDays, correctedValDate });
    } else if (correctedValDate.getTime() > nowMs) {
      toReopen.push({ p, tf, correctDays, correctedValDate });
    } else {
      toRelabelOnly.push({ p, tf, correctDays, correctedValDate });
    }
  }

  console.log(`\nAffected: ${toFixPending.length + toReopen.length + toRelabelOnly.length}`);
  console.log(`  pending rows — validation_date will be corrected:        ${toFixPending.length}`);
  console.log(`  resolved too early — will be REOPENED for regrading:     ${toReopen.length}`);
  console.log(`  resolved, corrected window already elapsed too — date-only fix: ${toRelabelOnly.length}`);

  const all = [...toFixPending, ...toReopen, ...toRelabelOnly];
  const sample = all.slice(0, 20);
  for (const { p, tf, correctDays, correctedValDate } of sample) {
    console.log(`  [${p.id}] "${p.topic}" — tf="${tf}" storedValDate=${p.validation_date?.slice(0,10)} correctDays=${correctDays} correctedValDate=${correctedValDate.toISOString().slice(0,10)} resolved=${p.correct !== null}`);
  }
  if (sample.length < all.length) console.log(`  ... and ${all.length - sample.length} more`);

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
