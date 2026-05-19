import { createClient } from '@supabase/supabase-js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const predictionPath = path.resolve(_dir, '../data/prediction-log.json');
const reputationPath = path.resolve(_dir, '../data/source-reputation.json');

function _setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://investmentinformatics.ai';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function _getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICEKEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function _checkRateLimit(supabase, ip) {
  if (!supabase) return true;
  const now = new Date();
  const windowStart = new Date(now - 60000);
  const key = `${ip}:check-markets`;
  try {
    const { data } = await supabase.from('rate_limits').select('count, window_start').eq('key', key).maybeSingle();
    if (!data || new Date(data.window_start) < windowStart) {
      await supabase.from('rate_limits').upsert({ key, count: 1, window_start: now.toISOString() });
      return true;
    }
    if (data.count >= 10) return false;
    await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('key', key);
    return true;
  } catch (_) { return false; }
}

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
  _setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const supabase = _getSupabase();
  const allowed = await _checkRateLimit(supabase, ip);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

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
    console.error('[check-markets]', err.message);
    return res.status(500).json({ error: 'Market check failed' });
  }
}
