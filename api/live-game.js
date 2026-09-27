import { findGameContextForQuestion } from '../lib/espn-live.js';
import { getSupabase, setCors, checkRateLimit, clientIp } from '../lib/http.js';

// ── Lightweight live-game lookup (no LLM call) ─────────────────────────────
// Powers the LIVE badge + score/period/clock shown directly on sports market
// cards in markets.html, without triggering a full (Claude-backed) analysis.
// Cheap enough to call per-card: just an ESPN scoreboard + summary fetch.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'live-game', 60);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const question = typeof req.query.question === 'string' ? req.query.question.slice(0, 300) : '';
  const sport = typeof req.query.sport === 'string' ? req.query.sport.replace(/[^a-zA-Z]/g, '').slice(0, 20) : null;
  const daysLeft = req.query.daysLeft != null ? parseInt(req.query.daysLeft, 10) : null;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  try {
    const context = await findGameContextForQuestion(question, sport, Number.isFinite(daysLeft) ? daysLeft : null);
    if (!context) return res.status(200).json({ found: false });
    return res.status(200).json({ found: true, ...context });
  } catch (err) {
    console.error('[live-game]', err.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
