import type { VercelRequest, VercelResponse } from '@vercel/node';

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN ?? '';
// Below this many characters of stripped text, assume the page is a JS shell and try headless.
const JS_SHELL_THRESHOLD = 500;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60000);
}

async function fetchWithBrowserless(url: string): Promise<string> {
  const res = await fetch(
    `https://chrome.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, waitFor: 3000 }),
      signal: AbortSignal.timeout(25000),
    }
  );
  if (res.status === 429 || res.status === 402) {
    // Log loudly so this shows up in Vercel error logs and triggers any alerts.
    console.error('[MenuVoice] BROWSERLESS_CREDITS_EXHAUSTED — headless fallback disabled until plan is renewed.');
    throw new Error('credits_exhausted');
  }
  if (!res.ok) throw new Error(`Browserless error (${res.status})`);
  return stripHtml(await res.text());
}

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
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MenuVoice/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Hey, sorry — that website returned an error (${response.status}). Double-check the link and try again.` });
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.startsWith('image/')) {
      return res.status(200).json({ imageUrl: url });
    }

    if (contentType.startsWith('application/pdf')) {
      return res.status(415).json({ error: "Hey, sorry — that link goes to a PDF file, and I can't read those yet. Try finding the menu as a regular webpage instead." });
    }

    let text = stripHtml(await response.text());

    // Page looks like an empty JS shell — retry with headless browser if token is configured.
    if (text.length < JS_SHELL_THRESHOLD && BROWSERLESS_TOKEN) {
      try {
        const headlessText = await fetchWithBrowserless(url);
        if (headlessText.length > text.length) text = headlessText;
      } catch {
        // Headless failed — proceed with whatever the simple scrape got.
      }
    }

    return res.status(200).json({ text });
  } catch (e: any) {
    const msg =
      e?.name === 'TimeoutError'
        ? "Hey, sorry — that website is taking too long to respond. Try again in a moment."
        : "Hey, sorry — I couldn't reach that website. Check the link and try again.";
    return res.status(502).json({ error: msg });
  }
}
