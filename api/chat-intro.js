import { getClerkUser } from '../lib/auth.js';
import { getSupabase, setCors } from '../lib/http.js';

// Backs the chat widget's intro message (see chat-widget.js playIntro()):
// the first few times a signed-in user opens the AI Informant, they get the
// full two-line walkthrough; after that, a short quirky one-liner. Returns
// how many times the intro has already been shown, then increments it for
// next time. Best-effort — a save failure just means the count doesn't
// advance, not a broken chat.
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

  const count = existing?.shown_count || 0;

  supabase
    .from('chat_intro_views')
    .upsert({ user_id: user.id, shown_count: count + 1, updated_at: new Date().toISOString() })
    .then(({ error }) => { if (error) console.error('[chat-intro] save failed:', error); });

  return res.status(200).json({ count });
}
