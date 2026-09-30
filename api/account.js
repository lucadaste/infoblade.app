import { getClerkUser } from '../lib/auth.js';
import { getSupabase, setCors } from '../lib/http.js';
import { deleteUserData } from '../lib/account-data.js';

// DELETE /api/account — erases the signed-in user's stored data. account.html
// calls this right after deleting the Clerk account (with a token fetched just
// before), and api/clerk-webhook.js repeats the same cleanup as a backstop.
export default async function handler(req, res) {
  setCors(res, { methods: 'DELETE, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).end();

  const user = await getClerkUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await deleteUserData(getSupabase({ required: true }), user.id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[account] data deletion failed for', user.id, err);
    return res.status(500).json({ error: 'Could not delete account data.' });
  }
}
