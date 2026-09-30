import crypto from 'node:crypto';
import { getSupabase } from '../lib/http.js';
import { deleteUserData } from '../lib/account-data.js';

// Clerk → POST /api/clerk-webhook. Clerk sends webhooks through Svix; each
// request is signed with CLERK_WEBHOOK_SECRET ("whsec_…", from the endpoint's
// page in the Clerk dashboard). Only user.deleted is acted on: it removes the
// user's stored data even when the account was deleted outside account.html
// (Clerk dashboard, or the page's own cleanup call failing).

export const config = { api: { bodyParser: false } };

const TOLERANCE_SECONDS = 5 * 60;

// The signature covers the exact bytes Clerk sent, so read the raw stream
// rather than a parsed-and-restringified req.body (touching req.body first
// would make the platform parse and consume it).
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return '';
}

// Exported for tests.
export function verifySvixSignature({ secret, id, timestamp, signatureHeader, body, now = Date.now() }) {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();

  // Header is a space-separated list like "v1,<base64> v1,<base64>".
  return signatureHeader.split(' ').some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[clerk-webhook] CLERK_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const body = await readRawBody(req);
  const ok = verifySvixSignature({
    secret,
    id: req.headers['svix-id'],
    timestamp: req.headers['svix-timestamp'],
    signatureHeader: req.headers['svix-signature'],
    body,
  });
  if (!ok) return res.status(401).json({ error: 'Invalid signature' });

  let event;
  try { event = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (event.type !== 'user.deleted') return res.status(200).json({ ignored: event.type });

  const userId = event.data?.id;
  if (!userId) return res.status(400).json({ error: 'Missing user id' });

  try {
    await deleteUserData(getSupabase({ required: true }), userId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    // A non-2xx makes Svix retry the delivery later.
    console.error('[clerk-webhook] data deletion failed for', userId, err);
    return res.status(500).json({ error: 'Deletion failed' });
  }
}
