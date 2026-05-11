import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const predictionPath = path.resolve(_dir, '../data/prediction-log.json');
const reputationPath = path.resolve(_dir, '../data/source-reputation.json');

async function readJSON(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8') || JSON.stringify(fallback));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function fetchCurrentPrices(tickers) {
  if (!tickers.length) return {};
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();
    const prices = {};
    for (const q of data?.quoteResponse?.result || []) {
      if (q.regularMarketPrice) prices[q.symbol] = q.regularMarketPrice;
    }
    return prices;
  } catch (_) { return {}; }
}

// A ticker direction is "correct" if it moved at least 0.5% the predicted way.
// Returns { correct, incorrect, neutral } counts.
function scoreDirections(winnerTickers, loserTickers, baseline, current) {
  let correct = 0, incorrect = 0, neutral = 0;

  for (const t of winnerTickers) {
    if (!baseline[t] || !current[t]) continue;
    const change = (current[t] - baseline[t]) / baseline[t];
    if (change > 0.005) correct++;
    else if (change < -0.005) incorrect++;
    else neutral++;
  }

  for (const t of loserTickers) {
    if (!baseline[t] || !current[t]) continue;
    const change = (current[t] - baseline[t]) / baseline[t];
    if (change < -0.005) correct++;
    else if (change > 0.005) incorrect++;
    else neutral++;
  }

  return { correct, incorrect, neutral };
}

function applyOutcomeToReputation(reputation, sources, correct) {
  const updated = { ...reputation };
  for (const source of sources) {
    if (!updated[source]) updated[source] = { attempts: 0, correct: 0 };
    updated[source] = {
      attempts: updated[source].attempts + 1,
      correct: updated[source].correct + (correct ? 1 : 0)
    };
  }
  return updated;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const entries = await readJSON(predictionPath, []);
    const now = new Date();

    // Only process predictions that are unlabeled and past their validation date
    const pending = entries.filter(e =>
      e.correct === null &&
      e.validationDate &&
      new Date(e.validationDate) <= now &&
      (e.winnerTickers?.length || e.loserTickers?.length) &&
      e.baselinePrices &&
      Object.keys(e.baselinePrices).length > 0
    );

    if (!pending.length) {
      return res.status(200).json({ validated: 0, message: 'No predictions ready for validation' });
    }

    // Collect all unique tickers across pending predictions
    const allTickers = [...new Set(
      pending.flatMap(e => [...(e.winnerTickers || []), ...(e.loserTickers || [])])
    )];

    const currentPrices = await fetchCurrentPrices(allTickers);
    let reputation = await readJSON(reputationPath, {});

    let validated = 0;
    const results = [];

    for (const entry of pending) {
      const scores = scoreDirections(
        entry.winnerTickers || [],
        entry.loserTickers || [],
        entry.baselinePrices,
        currentPrices
      );

      const total = scores.correct + scores.incorrect;
      if (total === 0) continue; // no priceable tickers, skip

      const correct = scores.correct / total >= 0.6;

      // Write outcome back into the entry in place
      const idx = entries.findIndex(e => e.id === entry.id);
      if (idx === -1) continue;

      entries[idx].correct = correct;
      entries[idx].validationMethod = 'auto';
      entries[idx].actualOutcome = {
        scores,
        currentPrices: Object.fromEntries(
          Object.entries(currentPrices).filter(([t]) =>
            (entry.winnerTickers || []).includes(t) || (entry.loserTickers || []).includes(t)
          )
        ),
        validatedAt: now.toISOString()
      };

      reputation = applyOutcomeToReputation(reputation, entry.sources || [], correct);
      validated++;
      results.push({ id: entry.id, topic: entry.topic, correct, scores });
    }

    await writeJSON(predictionPath, entries);
    await writeJSON(reputationPath, reputation);

    return res.status(200).json({ validated, results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
