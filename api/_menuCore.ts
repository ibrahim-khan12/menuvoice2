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
const MAX_HTML_BYTES = 2 * 1024 * 1024;

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
  incomplete?: boolean;
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

async function readCappedBody(response: Response, maxBytes: number, tooLargeMessage: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FriendlyError(tooLargeMessage);
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new FriendlyError(tooLargeMessage);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new FriendlyError(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readCappedText(response: Response, maxBytes: number, tooLargeMessage: string): Promise<string> {
  const bytes = await readCappedBody(response, maxBytes, tooLargeMessage);
  return new TextDecoder().decode(bytes);
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
  const res = await fetch('https://chrome.browserless.io/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BROWSERLESS_TOKEN}` },
    body: JSON.stringify({ url, waitFor: 3000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429 || res.status === 402) {
    console.error('[MenuVoice] BROWSERLESS_CREDITS_EXHAUSTED — headless fallback disabled until plan is renewed.');
    throw new Error('credits_exhausted');
  }
  if (!res.ok) throw new Error(`Browserless error (${res.status})`);
  return readCappedText(
    res,
    MAX_HTML_BYTES,
    'That rendered menu page is too large for me to read. Try a direct link to the menu instead.'
  );
}

// SSRF guard: only plain http(s) to public hosts. Blocks localhost, private
// ranges, link-local/metadata endpoints, and raw IPv6 literals.
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[|::)/i;
function assertPublicUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FriendlyError('That does not look like a valid web address.', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FriendlyError('Only regular web links are supported.', 400);
  }
  if (PRIVATE_HOST_RE.test(u.hostname) || u.hostname.endsWith('.internal') || u.hostname.endsWith('.local')) {
    throw new FriendlyError('That address cannot be reached from here.', 400);
  }
}

/** Fetch one URL and classify its content. No link-following at this level. */
async function fetchOne(url: string): Promise<MenuSource> {
  assertPublicUrl(url);
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
  // Redirects followed above could land on a private host — re-check.
  if (finalUrl !== url) assertPublicUrl(finalUrl);

  if (contentType.startsWith('image/')) {
    return { kind: 'image', url: finalUrl };
  }

  if (contentType.includes('pdf') || /\.pdf(\?|$)/i.test(finalUrl)) {
    const bytes = await readCappedBody(
      response,
      MAX_PDF_BYTES,
      'That menu PDF is too large for me to read. Try a link to the menu webpage instead.'
    );
    return { kind: 'pdf', base64: Buffer.from(bytes).toString('base64'), url: finalUrl };
  }

  let html = await readCappedText(
    response,
    MAX_HTML_BYTES,
    'That menu page is too large for me to read. Try a direct link to the menu instead.'
  );
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
  '{"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string,"incomplete":boolean}';

const PARSE_INSTRUCTIONS =
  'Extract EVERY menu item you can find. Group items into the menu\'s natural sections ' +
  '(appetizers, mains, desserts, drinks, specials, etc.). For each item include: name, ' +
  'description (if shown), price (as written, with currency symbol), and a best-effort ' +
  'ingredients list inferred from the name and description. Extract the restaurant name if visible. ' +
  'If no menu items are found, set categories to an empty array. ' +
  'Set "incomplete" to true if this looks like only PART of the menu — text cut off, ' +
  'sections referenced but missing, a page clearly continuing elsewhere, or unreadable areas. ' +
  'Set it to false if the menu appears whole. ' +
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

export function sanitizeMenu(menu: ParsedMenu): ParsedMenu {
  const categories: MenuCategory[] = [];
  if (Array.isArray(menu.categories)) {
    for (const cat of menu.categories) {
      if (!cat || typeof cat !== 'object' || Array.isArray(cat)) continue;
      const name = typeof cat.name === 'string' ? cat.name.trim() : '';
      if (!name || !Array.isArray(cat.items)) continue;
      const items: MenuItem[] = [];
      for (const item of cat.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const itemName = typeof item.name === 'string' ? item.name.trim() : '';
        if (!itemName) continue;
        items.push({
          name: itemName,
          description: typeof item.description === 'string' ? item.description : undefined,
          price: typeof item.price === 'string' ? item.price : undefined,
          ingredients: Array.isArray(item.ingredients)
            ? item.ingredients.filter((x): x is string => typeof x === 'string')
            : undefined,
        });
      }
      if (items.length) categories.push({ name, items });
    }
  }
  return {
    ...menu,
    categories,
    notes: typeof menu.notes === 'string' ? menu.notes : undefined,
    restaurantName: typeof menu.restaurantName === 'string' ? menu.restaurantName : undefined,
    incomplete: menu.incomplete === true,
  };
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
  return sanitizeMenu(parsed);
}

export function menuItemCount(menu: ParsedMenu): number {
  return menu.categories.reduce((s, c) => s + (c.items?.length ?? 0), 0);
}
