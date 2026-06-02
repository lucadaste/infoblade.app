/**
 * Context graph — queries historical prediction accuracy and formats it for AI prompts.
 * Called by analyze.js and chat.js to give Claude its own track record as context.
 */

/**
 * Build a context graph for given tickers + category from validated predictions.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ tickers?: string[], category?: string|null }} options
 */
export async function buildContextGraph(supabase, { tickers = [], category = null } = {}) {
  const { data: preds, error } = await supabase
    .from('predictions')
    .select('id, winner_tickers, loser_tickers, correct, category, analysis, created_at, topic')
    .not('correct', 'is', null)
    .order('created_at', { ascending: false })
    .limit(300);

  if (error || !preds) return null;

  // Overall accuracy
  const total = preds.length;
  const correct = preds.filter(p => p.correct).length;
  const overall = total >= 5
    ? { total, correct, accuracy: Math.round(correct / total * 100) }
    : null;

  // Category accuracy (need ≥ 3 resolved predictions to be meaningful)
  let categoryAccuracy = null;
  if (category) {
    const catPreds = preds.filter(p => p.category === category);
    if (catPreds.length >= 3) {
      const catCorrect = catPreds.filter(p => p.correct).length;
      categoryAccuracy = {
        category,
        total: catPreds.length,
        correct: catCorrect,
        accuracy: Math.round(catCorrect / catPreds.length * 100),
      };
    }
  }

  // Per-ticker history (need ≥ 2 resolved predictions to be meaningful)
  const tickerHistory = tickers.flatMap(ticker => {
    const tickerPreds = preds.filter(p =>
      (p.winner_tickers || []).includes(ticker) ||
      (p.loser_tickers  || []).includes(ticker)
    );
    if (tickerPreds.length < 2) return [];
    const wins = tickerPreds.filter(p => p.correct).length;
    const recent = tickerPreds[0];
    return [{
      ticker,
      total: tickerPreds.length,
      correct: wins,
      winRate: Math.round(wins / tickerPreds.length * 100),
      recentDirection: recent
        ? ((recent.winner_tickers || []).includes(ticker) ? 'bullish' : 'bearish')
        : null,
      recentCorrect: recent?.correct ?? null,
    }];
  });

  // Recent predictions involving these tickers (for chat context)
  const tickerSet = new Set(tickers);
  const recentPredictions = [];
  if (tickerSet.size > 0) {
    for (const p of preds.slice(0, 100)) {
      const matching = [...(p.winner_tickers || []), ...(p.loser_tickers || [])]
        .filter(t => tickerSet.has(t));
      if (!matching.length) continue;
      const daysAgo = Math.round((Date.now() - new Date(p.created_at)) / 86400000);
      recentPredictions.push({
        topic: p.topic,
        tickers: matching,
        direction: (p.winner_tickers || []).some(t => tickerSet.has(t)) ? 'bullish' : 'bearish',
        correct: p.correct,
        grade: p.analysis?.grade || null,
        daysAgo,
      });
      if (recentPredictions.length >= 5) break;
    }
  }

  return { overall, categoryAccuracy, tickerHistory, recentPredictions };
}

/**
 * Format a context graph into a compact text block for injection into AI prompts.
 * Returns an empty string if there's nothing meaningful to inject.
 */
export function formatContextForPrompt(graph) {
  if (!graph) return '';
  const lines = [];

  if (graph.overall && graph.overall.total >= 10) {
    lines.push(`Overall platform accuracy: ${graph.overall.accuracy}% (${graph.overall.correct}/${graph.overall.total} validated predictions)`);
  }

  if (graph.categoryAccuracy) {
    const c = graph.categoryAccuracy;
    lines.push(`${c.category} sector: ${c.accuracy}% accuracy (${c.correct}/${c.total} predictions)`);
  }

  for (const t of graph.tickerHistory) {
    const lastCall = t.recentCorrect === true
      ? ', last call: correct'
      : t.recentCorrect === false
        ? ', last call: incorrect'
        : '';
    lines.push(`${t.ticker}: ${t.winRate}% win rate (${t.correct}/${t.total} predictions${lastCall})`);
  }

  if (!lines.length) return '';

  return `\nPLATFORM TRACK RECORD (calibrate your confidence rating using this data):\n${lines.join('\n')}\nIf past accuracy on a relevant ticker or sector is below 50%, cap your confidence at 3 stars. If above 70%, bolder signals are appropriate.\n`;
}

/**
 * Format context graph as a compact block for the chat system prompt.
 * Only injected when the user message references specific tickers.
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

  for (const t of graph.tickerHistory) {
    const lastCall = t.recentCorrect === true
      ? `last call bullish, correct`
      : t.recentCorrect === false
        ? `last call ${t.recentDirection}, incorrect`
        : '';
    lines.push(`${t.ticker}: ${t.winRate}% win rate (${t.correct}/${t.total} predictions${lastCall ? `, ${lastCall}` : ''}).`);
  }

  for (const p of graph.recentPredictions.slice(0, 3)) {
    const outcome = p.correct === true ? 'correct' : p.correct === false ? 'incorrect' : 'pending';
    lines.push(`Recent: "${p.topic.slice(0, 80)}" — ${p.direction}, ${outcome}${p.daysAgo ? ` (${p.daysAgo}d ago)` : ''}.`);
  }

  if (!lines.length) return '';

  return `\n\nPLATFORM PAST PREDICTIONS (share these naturally if relevant to the user's question):\n${lines.join('\n')}`;
}
