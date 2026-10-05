import { getClerkUser } from '../lib/auth.js';
import { getSupabase, setCors } from '../lib/http.js';

// Backs the chat widget's intro message (see chat-widget.js playIntro()):
// a signed-in user gets the full two-line walkthrough until the first time
// they actually send the AI Informant a message, then a short quirky
// one-liner for good on every future visit. The "they've chatted before"
// flag itself is written by api/chat.js when it persists that first message
// (awaited there, not here) — this endpoint only reads it.
export default async function handler(req, res) {
  setCors(res, { methods: 'GET, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getClerkUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  let supabase;
  try { supabase = getSupabase({ required: true }); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  const { data: existing, error: readError } = await supabase
    .from('chat_intro_views')
    .select('shown_count')
    .eq('user_id', user.id)
    .maybeSingle();
  if (readError) { console.error('[chat-intro]', readError); return res.status(500).json({ error: 'Could not load intro state' }); }

  return res.status(200).json({ hasChatted: !!existing && existing.shown_count > 0 });
}
