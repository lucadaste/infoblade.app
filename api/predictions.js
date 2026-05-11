import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.resolve(_dir, '../data/prediction-log.json');
const reputationPath = path.resolve(_dir, '../data/source-reputation.json');

async function readStore() {
  try {
    const file = await fs.readFile(storePath, 'utf-8');
    return JSON.parse(file || '[]');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeStore(entries) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(entries, null, 2), 'utf-8');
}

async function readReputation() {
  try {
    return JSON.parse(await fs.readFile(reputationPath, 'utf-8') || '{}');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeReputation(data) {
  await fs.mkdir(path.dirname(reputationPath), { recursive: true });
  await fs.writeFile(reputationPath, JSON.stringify(data, null, 2), 'utf-8');
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

function buildRecord(body) {
  return {
    id: `pred_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    createdAt: new Date().toISOString(),
    topic: body.topic || null,
    headlines: body.headlines || [],
    sources: body.sources || [],
    sourceGrades: body.sourceGrades || {},
    minGrade: body.minGrade || 'medium',
    impactTimeframe: body.impactTimeframe || null,
    analysis: body.analysis || null,
    actualOutcome: body.actualOutcome || null,
    correct: typeof body.correct === 'boolean' ? body.correct : null,
    notes: body.notes || null
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const entries = await readStore();
      if (req.query?.withReputation === '1') {
        const reputation = await readReputation();
        return res.status(200).json({ entries, reputation });
      }
      return res.status(200).json({ entries });
    }

    if (req.method === 'POST') {
      const body = req.body;
      const record = buildRecord(body);
      const entries = await readStore();
      entries.push(record);
      await writeStore(entries);
      return res.status(201).json({ record });
    }

    if (req.method === 'PATCH') {
      const { id, actualOutcome, correct, notes } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing record id' });
      const entries = await readStore();
      const index = entries.findIndex(entry => entry.id === id);
      if (index === -1) return res.status(404).json({ error: 'Record not found' });

      const wasAlreadyLabeled = typeof entries[index].correct === 'boolean';
      if (actualOutcome !== undefined) entries[index].actualOutcome = actualOutcome;
      if (correct !== undefined) entries[index].correct = correct;
      if (notes !== undefined) entries[index].notes = notes;
      await writeStore(entries);

      if (typeof correct === 'boolean' && !wasAlreadyLabeled) {
        const reputation = await readReputation();
        const sources = entries[index].sources || [];
        await writeReputation(applyOutcomeToReputation(reputation, sources, correct));
      }

      return res.status(200).json({ record: entries[index] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
