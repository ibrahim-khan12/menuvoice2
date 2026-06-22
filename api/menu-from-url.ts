// POST { url } -> { menu: ParsedMenu }
// One call does everything server-side: fetch (HTML / PDF / image, JS-shell
// fallback, one menu-link hop from homepages) then OpenAI extraction.
// Replaces the old client round trip of /api/scrape -> /api/chat.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchMenuSource, parseMenuSource, menuItemCount, FriendlyError } from './_menuCore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { url } = (req.body ?? {}) as { url?: string };
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }

  try {
    const source = await fetchMenuSource(url);
    const menu = await parseMenuSource(source);
    if (menuItemCount(menu) === 0) {
      return res.status(422).json({
        error:
          "I couldn't find any menu items on that page. It might be the homepage rather than the menu itself. " +
          'Try adding /menu to the address, or just type the restaurant name instead.',
      });
    }
    return res.status(200).json({ menu, sourceUrl: source.url });
  } catch (e: any) {
    if (e instanceof FriendlyError) return res.status(e.status).json({ error: e.message });
    const msg =
      e?.name === 'TimeoutError'
        ? 'That website is taking too long to respond. Try again in a moment.'
        : "I couldn't reach that website. Check the link and try again.";
    return res.status(502).json({ error: msg });
  }
}
