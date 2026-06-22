import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

// GET  /api/sync?email=x   — fetch stored data for this email
// POST /api/sync            — save data { email, profile, restaurants }

function emailKey(email: string) {
  return `user:${email.trim().toLowerCase()}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const email = req.query.email as string;
    if (!email) return res.status(400).json({ error: 'email required' });
    const data = await kv.get(emailKey(email));
    return res.status(200).json(data ?? null);
  }

  if (req.method === 'POST') {
    const { email, profile, restaurants } = req.body ?? {};
    if (!email) return res.status(400).json({ error: 'email required' });
    await kv.set(emailKey(email), { profile, restaurants, updatedAt: Date.now() });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
