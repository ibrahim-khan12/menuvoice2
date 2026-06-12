// Shared server-side menu pipeline (underscore prefix = not a Vercel route).
// Used by api/menu-from-url.ts and api/find-menu.ts.
//
// fetchMenuSource(url)  -> classified content: HTML text | PDF base64 | image URL.
//                          Handles JS-shell pages (Browserless fallback) and
//                          follows ONE "menu" link hop when a page has no menu
//                          signal (most users paste the homepage, not /menu).
// parseMenuSource(src)  -> ParsedMenu via OpenAI (vision model; PDFs as file input).

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN ?? '';
const JS_SHELL_THRESHOLD = 500;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

export const PARSE_MODEL = process.env.VISION_MODEL ?? 'gpt-5.4-mini';

export interface MenuItem {
  name: string;
  description?: string;
  price?: string;
  ingredients?: string[];
}
export interface MenuCategory { name: string; items: MenuItem[]; }
export interface ParsedMenu {
  categories: MenuCategory[];
  notes?: string;
  restaurantName?: string;
}

export type MenuSource =
  | { kind: 'html'; text: string; html: string; url: string }
  | { kind: 'pdf'; base64: string; url: string }
  | { kind: 'image'; url: string };

export class FriendlyError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

export function stripHtml(html: string): string {
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

/** Rough "does this text look like a menu" signal: count price-like tokens. */
export function priceSignals(text: string): number {
  return (text.match(/[$€£]\s?\d{1,3}(?:[.,]\d{2})?|\d{1,3}\.\d{2}\b/g) ?? []).length;
}

/** Hrefs on the page that look like links to a menu (absolute, deduped). */
export function findMenuLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 5) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!/menu|food|dinner|lunch|breakfast|brunch|dining|eat|order/i.test(href + ' ' + label)) continue;
    if (/instagram|facebook|twitter|tiktok|mailto:|tel:/i.test(href)) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (!seen.has(abs) && abs !== baseUrl) {
        seen.add(abs);
        out.push(abs);
      }
    } catch {}
  }
  // PDFs and /menu paths first — they are the most likely full menus.
  return out.sort((a, b) => Number(scoreLink(b)) - Number(scoreLink(a)));
}

function scoreLink(url: string): number {
  let s = 0;
  if (/\.pdf(\?|$)/i.test(url)) s += 3;
  if (/menu/i.test(url)) s += 2;
  if (/food|dinner|lunch/i.test(url)) s += 1;
  return s;
}

async function fetchWithBrowserless(url: string): Promise<string> {
  const res = await fetch(`https://chrome.browserless.io/content?token=${BROWSERLESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, waitFor: 3000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429 || res.status === 402) {
    console.error('[MenuVoice] BROWSERLESS_CREDITS_EXHAUSTED — headless fallback disabled until plan is renewed.');
    throw new Error('credits_exhausted');
  }
  if (!res.ok) throw new Error(`Browserless error (${res.status})`);
  return res.text();
}

/** Fetch one URL and classify its content. No link-following at this level. */
async function fetchOne(url: string): Promise<MenuSource> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/xhtml+xml,application/pdf,image/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new FriendlyError(
      `That website returned an error (${response.status}). Double-check the link and try again.`,
      502
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const finalUrl = response.url || url;

  if (contentType.startsWith('image/')) {
    return { kind: 'image', url: finalUrl };
  }

  if (contentType.includes('pdf') || /\.pdf(\?|$)/i.test(finalUrl)) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) {
      throw new FriendlyError('That menu PDF is too large for me to read. Try a link to the menu webpage instead.');
    }
    return { kind: 'pdf', base64: Buffer.from(buf).toString('base64'), url: finalUrl };
  }

  let html = await response.text();
  let text = stripHtml(html);

  // JS shell? Re-fetch rendered HTML through Browserless when configured.
  if (text.length < JS_SHELL_THRESHOLD && BROWSERLESS_TOKEN) {
    try {
      const rendered = await fetchWithBrowserless(finalUrl);
      const renderedText = stripHtml(rendered);
      if (renderedText.length > text.length) {
        html = rendered;
        text = renderedText;
      }
    } catch {}
  }

  return { kind: 'html', text, html, url: finalUrl };
}

/**
 * Fetch a URL; if it's an HTML page with weak menu signal but it links to a
 * menu page or PDF, follow the best link one hop and use whichever is stronger.
 */
export async function fetchMenuSource(url: string): Promise<MenuSource> {
  const first = await fetchOne(url);
  if (first.kind !== 'html') return first;

  if (priceSignals(first.text) >= 5) return first;

  for (const link of findMenuLinks(first.html, first.url).slice(0, 2)) {
    try {
      const next = await fetchOne(link);
      if (next.kind !== 'html') return next; // a PDF or image menu — take it
      if (priceSignals(next.text) > priceSignals(first.text)) return next;
    } catch {}
  }
  return first;
}

const MENU_JSON_SHAPE =
  '{"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string}';

const PARSE_INSTRUCTIONS =
  'Extract EVERY menu item you can find. Group items into the menu\'s natural sections ' +
  '(appetizers, mains, desserts, drinks, specials, etc.). For each item include: name, ' +
  'description (if shown), price (as written, with currency symbol), and a best-effort ' +
  'ingredients list inferred from the name and description. Extract the restaurant name if visible. ' +
  'If no menu items are found, set categories to an empty array. ' +
  `Respond ONLY with JSON matching: ${MENU_JSON_SHAPE}`;

async function openaiChat(body: object): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new FriendlyError('No API key configured on the server.', 500);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[MenuVoice] OpenAI parse error:', res.status, text.slice(0, 500));
    throw new FriendlyError('Something went wrong reading that menu. Please try again in a moment.', 502);
  }
  return res.json();
}

/** Extract the first JSON object from model output (tolerates code fences/prose). */
export function extractJson(raw: string): any {
  const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new FriendlyError('The menu reader returned something unreadable. Please try again.');
}

/** Run OpenAI extraction over a classified menu source. Throws FriendlyError. */
export async function parseMenuSource(src: MenuSource): Promise<ParsedMenu> {
  let content: any;
  if (src.kind === 'image') {
    content = [
      { type: 'text', text: 'You are reading an image of a restaurant menu. ' + PARSE_INSTRUCTIONS },
      { type: 'image_url', image_url: { url: src.url, detail: 'high' } },
    ];
  } else if (src.kind === 'pdf') {
    content = [
      {
        type: 'file',
        file: { filename: 'menu.pdf', file_data: `data:application/pdf;base64,${src.base64}` },
      },
      { type: 'text', text: 'You are reading a PDF of a restaurant menu. ' + PARSE_INSTRUCTIONS },
    ];
  } else {
    if (!src.text.trim()) {
      throw new FriendlyError(
        'That page looks empty to me. Try linking directly to their menu page, like adding /menu to the address.'
      );
    }
    content =
      'You are reading text scraped from a restaurant website. ' + PARSE_INSTRUCTIONS +
      '\n\nWEBSITE TEXT:\n' + src.text;
  }

  const json = await openaiChat({
    model: PARSE_MODEL,
    messages: [{ role: 'user', content }],
    // response_format json_object is not supported alongside file inputs on all
    // models — extractJson() handles fenced/prose output either way.
    ...(src.kind === 'html' ? { response_format: { type: 'json_object' } } : {}),
  });

  const raw = json.choices?.[0]?.message?.content ?? '{}';
  const parsed = extractJson(raw) as ParsedMenu;
  if (!Array.isArray(parsed.categories)) parsed.categories = [];
  return parsed;
}

export function menuItemCount(menu: ParsedMenu): number {
  return menu.categories.reduce((s, c) => s + (c.items?.length ?? 0), 0);
}
