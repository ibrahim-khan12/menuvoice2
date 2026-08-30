import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withCartesiaKey } from './_cartesia.js';
import { enforceRateLimit } from './_rateLimit.js';

const CARTESIA_VERSION = '2026-03-01';
// Cartesia has temporarily disabled speed control on Sonic 3.5. Meet My Menu AI
// exposes a speaking-speed setting, so default to Sonic 3 where the
// generation_config.speed value is honored. An explicit environment override
// remains available for deployments that prioritize a different model.
export const CARTESIA_TTS_MODEL_DEFAULT = 'sonic-3';
const CAPACITOR_ORIGIN = 'capacitor://localhost';

export function applyTtsCors(req: VercelRequest, res: VercelResponse): void {
  const origin = String(req.headers.origin || '');
  if (origin === CAPACITOR_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CAPACITOR_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyTtsCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  if (!(await enforceRateLimit(req, res, 'tts'))) return;
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
    model_id: process.env.CARTESIA_TTS_MODEL || CARTESIA_TTS_MODEL_DEFAULT,
    transcript,
    voice: { mode: 'id', id: voiceId },
    language: 'en',
    output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    generation_config: { speed: resolveSpeechSpeed(body) },
  });

  // Rotate across Cartesia keys; null means every key is out of credits.
  const upstream = await withCartesiaKey(
    'tts',
    (key) => fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: payload,
    }),
    transcript.length,
  );
  // Null (all keys exhausted) or any non-OK response -> fall back to OpenAI.
  if (!upstream || !upstream.ok) return null;
  return Buffer.from(await upstream.arrayBuffer());
}

export function resolveSpeechSpeed(
  body: unknown,
  configuredSpeed: string | undefined = process.env.CARTESIA_TTS_SPEED,
): number {
  const requested =
    typeof body === 'object' && body !== null && typeof (body as { speed?: unknown }).speed === 'number'
      ? (body as { speed: number }).speed
      : Number.NaN;
  const configured = Number(configuredSpeed);
  const speed = Number.isFinite(requested) ? requested : Number.isFinite(configured) ? configured : 1;
  return Math.max(0.5, Math.min(2, speed));
}
