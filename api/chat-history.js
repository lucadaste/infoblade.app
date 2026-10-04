import { getClerkUser } from '../lib/auth.js';
import { getSupabase, setCors, secretMatches } from '../lib/http.js';

// Account-synced AI Informant chat history (see chat-widget.js's clock icon
// and api/chat.js, which writes the rows this endpoint reads). Rows are a
// rolling 7-day window, not permanent storage — see the cleanup branch below,
// cron'd daily in vercel.json.
const RETENTION_DAYS = 7;

export default async function handler(req, res) {
  setCors(res, { methods: 'GET, OPTIONS', headers: 'Content-Type, Authorization, X-Validate-Secret' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let supabase;
  try { supabase = getSupabase({ required: true }); } catch (e) { return res.status(500).json({ error: 'Database configuration error' }); }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();

  // Cron-only cleanup pass — purges rows past the retention window. Checked
  // before requiring a Clerk user since the cron has no end-user token.
  if (req.query.cleanup === 'true') {
    const cronSecret = process.env.CRON_SECRET;
    const manualSecret = process.env.VALIDATE_SECRET;
    const authHeader = req.headers['authorization'];
    const manualToken = req.headers['x-validate-secret'];
    const isCron = !!cronSecret && secretMatches(authHeader, `Bearer ${cronSecret}`);
    const isManual = !!manualSecret && secretMatches(manualToken, manualSecret);
    if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

    const { error, count } = await supabase.from('chat_messages').delete({ count: 'exact' }).lt('created_at', cutoff);
    if (error) { console.error('[chat-history cleanup]', error); return res.status(500).json({ error: 'Cleanup failed' }); }
    return res.status(200).json({ ok: true, deleted: count ?? null });
  }

  const user = await getClerkUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // One specific conversation's full transcript.
  if (req.query.session_id) {
    const sessionId = String(req.query.session_id).slice(0, 100);
    const { data, error } = await supabase
      .from('chat_messages')
      .select('role, content, created_at')
      .eq('user_id', user.id)
      .eq('session_id', sessionId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true });
    if (error) { console.error('[chat-history]', error); return res.status(500).json({ error: 'Could not load conversation' }); }
    return res.status(200).json({ messages: data || [] });
  }

  // The list behind the clock icon: one entry per conversation from the last
  // 7 days, newest first, with its opening message as the preview. There's
  // no SQL "group by, keep first row" here — PostgREST doesn't give us that
  // in one call — so this fetches the window's messages once and folds them
  // into sessions in JS. Bounded by the rate limits on api/chat.js, a user's
  // 7-day message count stays small enough for this to be cheap.
  const { data, error } = await supabase
    .from('chat_messages')
    .select('session_id, role, content, created_at')
    .eq('user_id', user.id)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) { console.error('[chat-history]', error); return res.status(500).json({ error: 'Could not load history' }); }

  const bySession = new Map();
  for (const row of data || []) {
    let s = bySession.get(row.session_id);
    if (!s) {
      s = { session_id: row.session_id, last_at: row.created_at, preview: null };
      bySession.set(row.session_id, s);
    }
    // Rows arrive newest-first across all sessions, so within one session_id
    // the last user-role row we see walking through them is its earliest —
    // i.e. the message that actually opened the conversation.
    if (row.role === 'user') s.preview = row.content.slice(0, 80);
  }
  const sessions = [...bySession.values()].sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
  return res.status(200).json({ sessions });
}
