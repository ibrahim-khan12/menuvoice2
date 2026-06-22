import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put } from '@vercel/blob';

// Accepts { imageBase64: string, filename?: string }
// Only called when the "Save menu photos" toggle is ON.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
