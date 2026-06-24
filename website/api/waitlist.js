import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const CONTACT_TYPES = new Set(['diner', 'restaurant', 'accessibility_org', 'other']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const ts = new Date().toISOString();
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.slice(0, 128) : null;
    const path = typeof req.body?.path === 'string' ? req.body.path.slice(0, 256) : null;
    const referrer = typeof req.body?.referrer === 'string' ? req.body.referrer.slice(0, 512) : null;
    const contactTypeRaw = typeof req.body?.contact_type === 'string' ? req.body.contact_type : '';
    const contactType = CONTACT_TYPES.has(contactTypeRaw) ? contactTypeRaw : 'other';
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null;
    const record = { email, contact_type: contactType, ts, session_id: sessionId, path, referrer, user_agent: userAgent };

    await redis.sadd('menuvoice:waitlist', email);
    await redis.lpush('menuvoice:waitlist:log', JSON.stringify(record));
    await redis.ltrim('menuvoice:waitlist:log', 0, 9999);
    await redis.lpush('menuvoice:site:events', JSON.stringify({
      ...record,
      event_name: 'waitlist_submit',
      metadata: { email, contact_type: contactType },
    }));
    await redis.ltrim('menuvoice:site:events', 0, 9999);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Waitlist signup failed', error);
    return res.status(500).json({ error: 'Unable to save signup' });
  }
}
