import { verifyToken } from '@clerk/backend';

export async function getClerkUser(req) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
      authorizedParties: [process.env.ALLOWED_ORIGIN || 'https://infoblade.app', 'capacitor://localhost'],
    });
    return { id: payload.sub };
  } catch (_) {
    return null;
  }
}
