import { computeCurrentFeatures, findSimilarMoves } from '../lib/situation-similarity-stocks.js';
import { getSupabase, setCors, checkRateLimit, clientIp } from '../lib/http.js';

// ── Lightweight short-horizon stock situation lookup (no LLM call) ─────────
// Powers a small stat block on feed.html's per-ticker analysis panel:
// "in similar past situations, how has this stock tended to move over the
// next 5 minutes?" Presented as historical statistical context, not a
// trading signal — see lib/situation-similarity-stocks.js's header comment.
// Returns { found: false } until the forward-collecting price-snapshot cron
// (api/collect-price-snapshots.js) has built up enough history — expected to
// be the case for the first while after this ships, not a bug.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = clientIp(req);
  const supabase = getSupabase();
  const allowed = await checkRateLimit(supabase, ip, 'stock-situation', 60);
  if (!allowed) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10) : '';
  if (!ticker) return res.status(400).json({ error: 'No ticker provided' });
  if (!supabase) return res.status(200).json({ found: false });

  try {
    const features = await computeCurrentFeatures(supabase, ticker);
    if (!features || features.pctChange5m == null) return res.status(200).json({ found: false });

    const similarMoves = await findSimilarMoves(supabase, {
      pctChange5m: features.pctChange5m,
      timeOfDayBucketVal: features.timeOfDayBucket,
    });

    if (!similarMoves) return res.status(200).json({ found: false, features });
    return res.status(200).json({ found: true, features, similarMoves });
  } catch (err) {
    console.error('[stock-situation]', err.message);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
