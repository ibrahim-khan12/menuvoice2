import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const s = (value, max) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

function originAllowed(req) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer || '';
  if (!host || !src) return true;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(200).json({ ok: true });

  const eventName = s(req.body?.event_name, 64);
  const sessionId = s(req.body?.session_id, 128);
  if (!eventName || !sessionId) return res.status(200).json({ ok: true });

  const metadata =
    req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
      ? req.body.metadata
      : {};

  const record = {
    ts: new Date().toISOString(),
    event_name: eventName,
    session_id: sessionId,
    path: s(req.body?.path, 256),
    referrer: s(req.body?.referrer, 512),
    metadata,
    user_agent: s(req.headers['user-agent'], 512),
  };

  try {
    await redis.lpush('menuvoice:site:events', JSON.stringify(record));
    await redis.ltrim('menuvoice:site:events', 0, 9999);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Website activity log failed', error);
    return res.status(200).json({ ok: true });
  }
}
