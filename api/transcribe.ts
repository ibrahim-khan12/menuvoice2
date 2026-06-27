import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cartesiaApiKeys, withCartesiaKey } from './_cartesia.js';

// Vercel's default body parser can't handle multipart. We stream the raw body
// straight through to OpenAI, preserving the Content-Type (with boundary).
export const config = { api: { bodyParser: false } };

const CARTESIA_VERSION = '2026-03-01';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (req.method === 'POST' && url.searchParams.get('cartesiaToken') === '1') {
    return cartesiaToken(res);
  }
  if (req.method !== 'POST') return res.status(405).end();
  const contentType = req.headers['content-type'] ?? '';
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);

  if (process.env.CARTESIA_STT_ENABLED === 'true') {
    const cartesia = await transcribeWithCartesia(contentType, body).catch((error) => {
      console.warn('Cartesia STT failed, falling back to OpenAI:', error);
      return null;
    });
    if (cartesia) {
      res.setHeader('X-Voice-Provider', 'cartesia');
      return res.status(200).json(cartesia);
    }
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'No API key configured on server.' });

  const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': contentType },
    body: body as unknown as BodyInit,
  });
  const data = await upstream.json();
  res.setHeader('X-Voice-Provider', 'openai');
  res.status(upstream.status).json(data);
}

async function cartesiaToken(res: VercelResponse) {
  if (process.env.CARTESIA_REALTIME_STT_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Cartesia realtime STT is not enabled.' });
  }

  if (cartesiaApiKeys().length === 0) {
    return res.status(500).json({ error: 'No Cartesia API key configured.' });
  }

  // Rotate across keys; null means every key is out of credits.
  const upstream = await withCartesiaKey('realtime-stt-token', (key) =>
    fetch('https://api.cartesia.ai/access-token', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grants: { stt: true },
        expires_in: 60,
      }),
    }),
  );
  if (!upstream) {
    return res.status(402).json({ error: 'All Cartesia keys are out of credits.' });
  }

  const raw = await upstream.text().catch(() => '');
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!upstream.ok) {
    const error = data?.message ?? data?.error ?? data?.title ?? data?.raw ?? 'Cartesia token request failed.';
    console.warn('Cartesia access-token failed:', { status: upstream.status, error });
    return res.status(upstream.status).json({ error });
  }

  const token = data?.token ?? data?.access_token;
  if (!token) return res.status(502).json({ error: 'Cartesia token response did not include a token.' });
  return res.status(200).json({ token, expires_in: data?.expires_in ?? 60 });
}

async function transcribeWithCartesia(contentType: string, body: Buffer): Promise<{ text: string } | null> {
  if (!contentType.includes('multipart/form-data')) return null;

  // Rotate across keys; null/non-OK -> caller falls back to OpenAI Whisper.
  const upstream = await withCartesiaKey('stt', (key) =>
    fetch('https://api.cartesia.ai/stt', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': contentType,
      },
      body: body as unknown as BodyInit,
    }),
  );
  if (!upstream || !upstream.ok) return null;

  const raw = await upstream.text().catch(() => '');
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  return { text: (data?.text ?? '').trim() };
}
