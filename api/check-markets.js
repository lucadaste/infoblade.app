import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const predictionPath = path.resolve(_dir, '../data/prediction-log.json');
const reputationPath = path.resolve(_dir, '../data/source-reputation.json');

async function readJSON(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf-8') || JSON.stringify(fallback)); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function writeJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function applyOutcomeToReputation(reputation, sources, correct) {
  const updated = { ...reputation };
  for (const source of (sources || [])) {
    if (!source) continue;
    if (!updated[source]) updated[source] = { attempts: 0, correct: 0 };
    updated[source] = { attempts: updated[source].attempts + 1, correct: updated[source].correct + (correct ? 1 : 0) };
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
    const pending = entries.filter(e =>
      e.type === 'prediction-market' &&
      e.correct === null &&
      (e.lean === 'Yes' || e.lean === 'No') &&
      e.marketSlug
    );

    if (!pending.length) {
      return res.status(200).json({ resolved: 0, checked: 0, message: 'No pending prediction market results to check' });
    }

    let reputation = await readJSON(reputationPath, {});
    let resolved = 0;
    const results = [];

    for (const entry of pending) {
      try {
        const polyRes = await fetch(
          `https://gamma-api.polymarket.com/events?slug=${entry.marketSlug}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
        );
        const events = await polyRes.json();
        const event = Array.isArray(events) ? events[0] : null;
        if (!event) continue;

        const ms = event.markets || [];
        const primary = ms.length === 1
          ? ms[0]
          : [...ms].sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))[0];

        if (!primary?.resolved) continue;

        const resolvedYes = parseFloat(primary.resolutionPrice) >= 0.5;
        const correct = (entry.lean === 'Yes' && resolvedYes) || (entry.lean === 'No' && !resolvedYes);

        const idx = entries.findIndex(e => e.id === entry.id);
        if (idx === -1) continue;

        entries[idx].correct = correct;
        entries[idx].resolvedOutcome = resolvedYes ? 'Yes' : 'No';
        entries[idx].validationMethod = 'auto-polymarket';
        entries[idx].resolvedAt = new Date().toISOString();

        reputation = applyOutcomeToReputation(reputation, entry.sources, correct);
        resolved++;
        results.push({ id: entry.id, topic: entry.topic, lean: entry.lean, resolvedOutcome: resolvedYes ? 'Yes' : 'No', correct });
      } catch (_) { continue; }
    }

    if (resolved > 0) {
      await writeJSON(predictionPath, entries);
      await writeJSON(reputationPath, reputation);
    }

    return res.status(200).json({ resolved, checked: pending.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
