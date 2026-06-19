/**
 * Context graph — queries historical prediction accuracy and formats it for AI prompts.
 * Called by analyze.js and chat.js to give Claude its own track record as context.
 */

function _parseTimeframeDays(str) {
  if (!str) return 30;
  const s = str.toLowerCase();
  if (s.includes('48 hour') || (s.match(/^2\s*day/))) return 2;
  const n = parseInt((s.match(/(\d+)/) || [])[1] || '1', 10);
  if (s.includes('day'))   return Math.min(n, 30);
  if (s.includes('week'))  return Math.min(n * 7, 90);
  if (s.includes('month')) return Math.min(n * 30, 365);
  return 30;
}

function _tfBucket(str) {
  const d = _parseTimeframeDays(str);
  if (d <= 7)  return 'short';
  if (d <= 30) return 'medium';
  return 'long';
}

/**
 * Build a context graph for given tickers + category from validated predictions.
 */
export async function buildContextGraph(supabase, { tickers = [], category = null } = {}) {
  const { data: preds, error } = await supabase
    .from('predictions')
    .select('id, winner_tickers, loser_tickers, correct, category, analysis, created_at, topic')
    .not('correct', 'is', null)
    .order('created_at', { ascending: false })
    .limit(300);

  if (error || !preds) return null;

  // ── Overall accuracy ───────────────────────────────────────────────────────
  const total   = preds.length;
  const correct = preds.filter(p => p.correct).length;
  const overall = total >= 5
    ? { total, correct, accuracy: Math.round(correct / total * 100) }
    : null;

  // ── Category accuracy ──────────────────────────────────────────────────────
  let categoryAccuracy = null;
  if (category) {
    const catPreds = preds.filter(p => p.category === category);
    if (catPreds.length >= 3) {
      const catCorrect = catPreds.filter(p => p.correct).length;
      categoryAccuracy = {
        category,
        total:    catPreds.length,
        correct:  catCorrect,
        accuracy: Math.round(catCorrect / catPreds.length * 100),
      };
    }
  }

  // ── Per-ticker history ─────────────────────────────────────────────────────
  const tickerHistory = tickers.flatMap(ticker => {
    const tickerPreds = preds.filter(p =>
      (p.winner_tickers || []).includes(ticker) ||
      (p.loser_tickers  || []).includes(ticker)
    );
    if (tickerPreds.length < 2) return [];
    const wins   = tickerPreds.filter(p => p.correct).length;
    const recent = tickerPreds[0];
    return [{
      ticker,
      total:           tickerPreds.length,
      correct:         wins,
      winRate:         Math.round(wins / tickerPreds.length * 100),
      recentDirection: recent
        ? ((recent.winner_tickers || []).includes(ticker) ? 'bullish' : 'bearish')
        : null,
      recentCorrect: recent?.correct ?? null,
    }];
  });

  // ── Recent predictions involving these tickers (for chat) ──────────────────
  const tickerSet = new Set(tickers);
  const recentPredictions = [];
  if (tickerSet.size > 0) {
    for (const p of preds.slice(0, 100)) {
      const matching = [...(p.winner_tickers || []), ...(p.loser_tickers || [])]
        .filter(t => tickerSet.has(t));
      if (!matching.length) continue;
      const daysAgo = Math.round((Date.now() - new Date(p.created_at)) / 86400000);
      recentPredictions.push({
        topic:     p.topic,
        tickers:   matching,
        direction: (p.winner_tickers || []).some(t => tickerSet.has(t)) ? 'bullish' : 'bearish',
        correct:   p.correct,
        grade:     p.analysis?.grade || null,
        daysAgo,
      });
      if (recentPredictions.length >= 5) break;
    }
  }

  // ── NEW: Directional accuracy per ticker ───────────────────────────────────
  // { NVDA: { bullish: {total,correct}, bearish: {total,correct} } }
  const tickerDirectional = {};
  for (const p of preds) {
    for (const t of (p.winner_tickers || [])) {
      if (!tickerDirectional[t]) tickerDirectional[t] = { bullish: { total: 0, correct: 0 }, bearish: { total: 0, correct: 0 } };
      tickerDirectional[t].bullish.total++;
      if (p.correct) tickerDirectional[t].bullish.correct++;
    }
    for (const t of (p.loser_tickers || [])) {
      if (!tickerDirectional[t]) tickerDirectional[t] = { bullish: { total: 0, correct: 0 }, bearish: { total: 0, correct: 0 } };
      tickerDirectional[t].bearish.total++;
      if (p.correct) tickerDirectional[t].bearish.correct++;
    }
  }

  // ── NEW: Accuracy by timeframe bucket ──────────────────────────────────────
  const timeframeAccuracy = {
    short:  { total: 0, correct: 0 },  // ≤ 7 days
    medium: { total: 0, correct: 0 },  // 8-30 days
    long:   { total: 0, correct: 0 },  // > 30 days
  };
  for (const p of preds) {
    const bucket = _tfBucket(p.analysis?.impact_timeframe);
    timeframeAccuracy[bucket].total++;
    if (p.correct) timeframeAccuracy[bucket].correct++;
  }

  // ── NEW: Category + direction accuracy ─────────────────────────────────────
  // { technology: { bullish: {total,correct}, bearish: {total,correct} } }
  const categoryDirectional = {};
  for (const p of preds) {
    const cat = p.category || 'any';
    const dir = p.analysis?.direction;
    if (dir !== 'bullish' && dir !== 'bearish') continue;
    if (!categoryDirectional[cat]) categoryDirectional[cat] = { bullish: { total: 0, correct: 0 }, bearish: { total: 0, correct: 0 } };
    categoryDirectional[cat][dir].total++;
    if (p.correct) categoryDirectional[cat][dir].correct++;
  }

  // ── NEW: Recent mistakes ───────────────────────────────────────────────────
  const recentMistakes = preds
    .filter(p => p.correct === false)
    .slice(0, 6)
    .map(p => ({
      topic:     p.topic,
      direction: p.analysis?.direction || null,
      tickers:   [...new Set([...(p.winner_tickers || []), ...(p.loser_tickers || [])])].slice(0, 3),
      timeframe: p.analysis?.impact_timeframe || null,
      grade:     p.analysis?.grade || null,
      score:     p.analysis?.accuracy_score ?? p.analysis?.score ?? null,
      // The actual ticker moves (what really happened)
      tickerMoves: p.analysis?.ticker_moves
        ? Object.entries(p.analysis.ticker_moves)
            .map(([sym, m]) => `${sym} ${m.pct > 0 ? '+' : ''}${m.pct}% (predicted ${m.direction})`)
            .slice(0, 3)
            .join(', ')
        : null,
    }));

  // ── NEW: Recent correct predictions ───────────────────────────────────────
  const recentWins = preds
    .filter(p => p.correct === true)
    .slice(0, 4)
    .map(p => ({
      topic:     p.topic,
      direction: p.analysis?.direction || null,
      tickers:   [...new Set([...(p.winner_tickers || []), ...(p.loser_tickers || [])])].slice(0, 3),
      timeframe: p.analysis?.impact_timeframe || null,
      grade:     p.analysis?.grade || null,
    }));

  return {
    overall,
    categoryAccuracy,
    tickerHistory,
    recentPredictions,
    // enhanced fields
    tickerDirectional,
    timeframeAccuracy,
    categoryDirectional,
    recentMistakes,
    recentWins,
  };
}

/**
 * Format context graph for injection into AI analysis prompts.
 * Richer than before: directional breakdown, timeframe calibration, recent mistakes.
 */
export function formatContextForPrompt(graph) {
  if (!graph) return '';
  const lines = [];

  // Overall
  if (graph.overall && graph.overall.total >= 5) {
    lines.push(`Overall platform accuracy: ${graph.overall.accuracy}% (${graph.overall.correct}/${graph.overall.total} validated predictions)`);
  }

  // Timeframe accuracy
  const tf = graph.timeframeAccuracy;
  if (tf) {
    const tfParts = [];
    if (tf.short.total >= 3)  tfParts.push(`short-term ≤1wk: ${Math.round(tf.short.correct  / tf.short.total  * 100)}% (${tf.short.correct}/${tf.short.total})`);
    if (tf.medium.total >= 3) tfParts.push(`medium-term 1-4wk: ${Math.round(tf.medium.correct / tf.medium.total * 100)}% (${tf.medium.correct}/${tf.medium.total})`);
    if (tf.long.total >= 3)   tfParts.push(`long-term >1mo: ${Math.round(tf.long.correct   / tf.long.total   * 100)}% (${tf.long.correct}/${tf.long.total})`);
    if (tfParts.length) lines.push(`Accuracy by timeframe: ${tfParts.join(' | ')}`);
  }

  // Category accuracy + directional breakdown
  if (graph.categoryAccuracy) {
    const c  = graph.categoryAccuracy;
    const cd = graph.categoryDirectional?.[c.category];
    let catLine = `${c.category} sector: ${c.accuracy}% overall (${c.correct}/${c.total})`;
    if (cd) {
      const parts = [];
      if (cd.bullish.total >= 2) parts.push(`bullish ${Math.round(cd.bullish.correct / cd.bullish.total * 100)}% (${cd.bullish.correct}/${cd.bullish.total})`);
      if (cd.bearish.total >= 2) parts.push(`bearish ${Math.round(cd.bearish.correct / cd.bearish.total * 100)}% (${cd.bearish.correct}/${cd.bearish.total})`);
      if (parts.length) catLine += ` — directional: ${parts.join(', ')}`;
    }
    lines.push(catLine);
  }

  // Per-ticker with directional breakdown
  for (const t of graph.tickerHistory || []) {
    const td = graph.tickerDirectional?.[t.ticker];
    const parts = [];
    if (td?.bullish.total >= 1) parts.push(`bullish ${td.bullish.correct}/${td.bullish.total}`);
    if (td?.bearish.total >= 1) parts.push(`bearish ${td.bearish.correct}/${td.bearish.total}`);
    const dirBreakdown = parts.length ? ` (${parts.join(', ')})` : '';
    const lastCall = t.recentCorrect === true ? ', last call correct' : t.recentCorrect === false ? ', last call WRONG' : '';
    lines.push(`${t.ticker}: ${t.winRate}% win rate${dirBreakdown}${lastCall}`);
  }

  // Recent mistakes
  if (graph.recentMistakes?.length) {
    lines.push(`\nRecent INCORRECT predictions — study to avoid repeating:`);
    for (const m of graph.recentMistakes) {
      const tkrs = m.tickers.length ? ` [${m.tickers.join(', ')}]` : '';
      const actual = m.tickerMoves ? ` — actual: ${m.tickerMoves}` : '';
      lines.push(`  WRONG: ${m.direction || '?'} call on "${m.topic.slice(0, 80)}"${tkrs} (${m.timeframe || '?'})${actual}`);
    }
  }

  if (!lines.length) return '';

  // Build targeted calibration rules from the data
  const rules = [];

  // Direction-specific rules for requested tickers
  for (const t of graph.tickerHistory || []) {
    const td = graph.tickerDirectional?.[t.ticker];
    if (!td) continue;
    if (td.bullish.total >= 2 && td.bearish.total >= 1) {
      const bullAcc = Math.round(td.bullish.correct / td.bullish.total * 100);
      const bearAcc = Math.round(td.bearish.correct / td.bearish.total * 100);
      if (bullAcc >= 70 && bearAcc <= 35) {
        rules.push(`${t.ticker}: historically strong on bullish calls (${bullAcc}%) but wrong on bearish (${bearAcc}%). Require overwhelming evidence for a bearish ${t.ticker} call; cap confidence at 2-3 stars if bearish.`);
      } else if (bearAcc >= 70 && bullAcc <= 35) {
        rules.push(`${t.ticker}: historically strong on bearish calls (${bearAcc}%) but wrong on bullish (${bullAcc}%). Be cautious about bullish ${t.ticker} calls; cap confidence at 2-3 stars if bullish.`);
      }
    }
  }

  // Timeframe rules
  if (tf) {
    const shortAcc  = tf.short.total  >= 3 ? Math.round(tf.short.correct  / tf.short.total  * 100) : null;
    const medAcc    = tf.medium.total >= 3 ? Math.round(tf.medium.correct / tf.medium.total * 100) : null;
    if (shortAcc !== null && shortAcc < 55) {
      rules.push(`Short-term calls (≤1 week) historically weak (${shortAcc}% correct). Use longer timeframes where possible; if short-term is appropriate for this event, cap confidence at 3 stars.`);
    }
    if (medAcc !== null && medAcc >= 65) {
      rules.push(`Medium-term calls (1-4 weeks) are our strongest timeframe (${medAcc}% correct). Lean toward 2-4 week timeframes when the event warrants it.`);
    }
  }

  // Category directional bias rules
  if (graph.categoryAccuracy && graph.categoryDirectional) {
    const cd = graph.categoryDirectional[graph.categoryAccuracy.category];
    if (cd && cd.bullish.total >= 2 && cd.bearish.total >= 2) {
      const bullAcc = Math.round(cd.bullish.correct / cd.bullish.total * 100);
      const bearAcc = Math.round(cd.bearish.correct / cd.bearish.total * 100);
      if (Math.abs(bullAcc - bearAcc) >= 20) {
        const strongDir  = bullAcc > bearAcc ? 'bullish' : 'bearish';
        const weakDir    = bullAcc > bearAcc ? 'bearish' : 'bullish';
        const strongAcc  = bullAcc > bearAcc ? bullAcc   : bearAcc;
        const weakAcc    = bullAcc > bearAcc ? bearAcc   : bullAcc;
        rules.push(`${graph.categoryAccuracy.category} sector has directional bias: ${strongDir} calls ${strongAcc}% correct vs ${weakDir} calls ${weakAcc}% correct. Default to ${strongDir} unless evidence strongly suggests ${weakDir}.`);
      }
    }
  }

  // Generic fallback rules if no specific data
  if (!rules.length) {
    rules.push('If past accuracy on a relevant ticker or sector is below 50%, cap your confidence at 3 stars.');
    rules.push('If above 70% on a relevant ticker or direction, bolder signals are appropriate.');
  }

  return [
    `\nPLATFORM TRACK RECORD — use this data to calibrate confidence and avoid past mistakes:`,
    lines.join('\n'),
    `\nCALIBRATION RULES (apply to this specific prediction):`,
    rules.map(r => `- ${r}`).join('\n'),
  ].join('\n');
}

/**
 * Format context graph as a compact block for the chat system prompt.
 */
export function formatContextForChat(graph) {
  if (!graph) return '';
  const lines = [];

  if (graph.overall && graph.overall.total >= 10) {
    lines.push(`Platform track record: ${graph.overall.accuracy}% accuracy across ${graph.overall.total} validated predictions.`);
  }

  if (graph.categoryAccuracy) {
    const c = graph.categoryAccuracy;
    lines.push(`${c.category} sector: ${c.accuracy}% (${c.correct}/${c.total}).`);
  }

  for (const t of graph.tickerHistory || []) {
    const td = graph.tickerDirectional?.[t.ticker];
    const parts = [];
    if (td?.bullish.total >= 1) parts.push(`bullish ${td.bullish.correct}/${td.bullish.total}`);
    if (td?.bearish.total >= 1) parts.push(`bearish ${td.bearish.correct}/${td.bearish.total}`);
    const dirStr = parts.length ? `, ${parts.join(', ')}` : '';
    const lastCall = t.recentCorrect === true
      ? `last call correct`
      : t.recentCorrect === false
        ? `last call incorrect`
        : '';
    lines.push(`${t.ticker}: ${t.winRate}% win rate (${t.correct}/${t.total}${dirStr}${lastCall ? `, ${lastCall}` : ''}).`);
  }

  for (const p of (graph.recentPredictions || []).slice(0, 3)) {
    const outcome = p.correct === true ? 'correct' : p.correct === false ? 'incorrect' : 'pending';
    lines.push(`Recent: "${p.topic.slice(0, 80)}" — ${p.direction}, ${outcome}${p.daysAgo ? ` (${p.daysAgo}d ago)` : ''}.`);
  }

  if (!lines.length) return '';

  return `\n\nPLATFORM PAST PREDICTIONS (share these naturally if relevant to the user's question):\n${lines.join('\n')}`;
}
