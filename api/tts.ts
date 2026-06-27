import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withCartesiaKey } from './_cartesia.js';

const CARTESIA_VERSION = '2026-03-01';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (process.env.CARTESIA_TTS_ENABLED === 'true') {
    const audio = await synthesizeWithCartesia(req.body).catch((error) => {
      console.warn('Cartesia TTS failed, falling back to OpenAI:', error);
      return null;
    });
    if (audio) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Voice-Provider', 'cartesia');
      return res.status(200).send(audio);
    }
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'No API key configured on server.' });

  const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    return res.status(upstream.status).send(text);
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('X-Voice-Provider', 'openai');
  res.status(200).send(buf);
}

async function synthesizeWithCartesia(body: any): Promise<Buffer | null> {
  const voiceId = process.env.CARTESIA_VOICE_ID;
  const transcript = typeof body?.input === 'string' ? body.input.trim() : '';
  if (!voiceId || !transcript) return null;

  const payload = JSON.stringify({
    model_id: process.env.CARTESIA_TTS_MODEL || 'sonic-3.5',
    transcript,
    voice: { mode: 'id', id: voiceId },
    language: 'en',
    output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    generation_config: { speed: Number(process.env.CARTESIA_TTS_SPEED || 1) },
  });

  // Rotate across Cartesia keys; null means every key is out of credits.
  const upstream = await withCartesiaKey('tts', (key) =>
    fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: payload,
    }),
  );
  // Null (all keys exhausted) or any non-OK response -> fall back to OpenAI.
  if (!upstream || !upstream.ok) return null;
  return Buffer.from(await upstream.arrayBuffer());
}
