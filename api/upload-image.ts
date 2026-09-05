import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put } from '@vercel/blob';

// Accepts { imageBase64: string, filename?: string }
// Only called when the "Save menu photos" toggle is ON.
//
// Web calls are same-origin (see apiUrl.ts); the only real cross-origin
// caller is the signed native app at this custom scheme. Matches the
// allowlist api/tts.ts and api/events.ts already use, instead of '*' —
// which let any third-party site's JS silently upload through a visiting
// user's browser and read back the resulting Blob URL.
const CAPACITOR_ORIGIN = 'capacitor://localhost';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestOrigin = String(req.headers.origin || '');
  if (requestOrigin === CAPACITOR_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CAPACITOR_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { imageBase64, filename } = (req.body ?? {}) as { imageBase64?: string; filename?: string };
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    const buf = Buffer.from(imageBase64, 'base64');
    const name = typeof filename === 'string' && filename ? filename : `capture-${Date.now()}.jpg`;
    const blob = await put(name, buf, { access: 'public', contentType: 'image/jpeg' });
    return res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error('[upload-image] error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
}
