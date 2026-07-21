export default function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://infoblade.app';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!clerkPublishableKey) return res.status(500).json({ error: 'Config unavailable' });

  return res.status(200).json({ clerkPublishableKey });
}
