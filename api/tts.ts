import type { VercelRequest, VercelResponse } from '@vercel/node';
import { looksLikeCartesiaCreditIssue, maybeNotifyCartesiaCreditIssue } from './_providerAlerts.js';

const CARTESIA_VERSION = '2026-03-01';
const CARTESIA_KEY_SLOTS = 4;

interface CartesiaKey {
  value: string;
  label: string;
}

interface CartesiaSuccess {
  audio: Buffer;
  keyLabel: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  let fallbackReason = 'cartesia_disabled';
  if (process.env.CARTESIA_TTS_ENABLED === 'true') {
    fallbackReason = cartesiaConfigStatus(req.body);
    const audio = fallbackReason === 'cartesia_ready'
      ? await synthesizeWithCartesia(req.body).catch((error) => {
          console.warn('Cartesia TTS failed, falling back to OpenAI:', error);
          fallbackReason = 'cartesia_error';
          return null;
        })
      : null;
    if (audio) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Voice-Provider', 'cartesia');
      res.setHeader('X-Voice-Key-Slot', audio.keyLabel);
      return res.status(200).send(audio.audio);
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
  res.setHeader('X-Voice-Fallback-Reason', fallbackReason);
  res.status(200).send(buf);
}

function cartesiaConfigStatus(body: any): string {
  const keys = cartesiaKeys();
  const voiceId = process.env.CARTESIA_VOICE_ID;
  const transcript = typeof body?.input === 'string' ? body.input.trim() : '';
  if (keys.length === 0) return 'cartesia_missing_api_key';
  if (!voiceId) return 'cartesia_missing_voice_id';
  if (!transcript) return 'cartesia_empty_input';
  return 'cartesia_ready';
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\n,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function cartesiaKeys(): CartesiaKey[] {
  const keys: CartesiaKey[] = [];
  const seen = new Set<string>();

  for (let i = 1; i <= CARTESIA_KEY_SLOTS; i++) {
    const value = process.env[`CARTESIA_API_KEY_${i}`]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      keys.push({ value, label: `key_${i}` });
    }
  }

  let nextListSlot = keys.length + 1;
  for (const value of splitEnvList(process.env.CARTESIA_API_KEYS)) {
    if (!seen.has(value)) {
      seen.add(value);
      keys.push({ value, label: `key_${nextListSlot}` });
      nextListSlot++;
    }
  }

  const legacy = process.env.CARTESIA_API_KEY?.trim();
  if (legacy && !seen.has(legacy)) {
    keys.push({ value: legacy, label: keys.length ? 'legacy_key' : 'key_1' });
  }

  return keys;
}

async function synthesizeWithCartesia(body: any): Promise<CartesiaSuccess | null> {
  const keys = cartesiaKeys();
  const voiceId = process.env.CARTESIA_VOICE_ID;
  const transcript = typeof body?.input === 'string' ? body.input.trim() : '';
  if (keys.length === 0 || !voiceId || !transcript) return null;

  let lastCreditIssue: { status: number; detail: string } | null = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const nextKey = keys[i + 1] ?? null;
    const upstream = await requestCartesiaTts({ key: key.value, voiceId, transcript });

    if (upstream.ok) {
      return {
        audio: Buffer.from(await upstream.arrayBuffer()),
        keyLabel: key.label,
      };
    }

    const text = await upstream.text();
    if (!looksLikeCartesiaCreditIssue(upstream.status, text)) {
      throw new Error(text || `Cartesia TTS request failed with HTTP ${upstream.status}.`);
    }

    lastCreditIssue = { status: upstream.status, detail: text };
    await maybeNotifyCartesiaCreditIssue({
      service: 'tts',
      status: upstream.status,
      detail: text,
      keyLabel: key.label,
      nextKeyLabel: nextKey?.label ?? null,
    });
    console.warn(`[MenuVoice] Cartesia ${key.label} credit/quota failure; trying ${nextKey?.label ?? 'OpenAI fallback'}.`);
  }

  if (lastCreditIssue) {
    throw new Error(`All Cartesia TTS keys exhausted or quota-limited. Last status: ${lastCreditIssue.status}. ${lastCreditIssue.detail}`);
  }
  return null;
}

function requestCartesiaTts(opts: { key: string; voiceId: string; transcript: string }): Promise<Response> {
  return fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.key}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: process.env.CARTESIA_TTS_MODEL || 'sonic-3.5',
      transcript: opts.transcript,
      voice: { mode: 'id', id: opts.voiceId },
      language: 'en',
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      generation_config: { speed: Number(process.env.CARTESIA_TTS_SPEED || 1) },
    }),
  });
}
