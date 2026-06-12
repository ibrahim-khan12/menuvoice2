// POST { query: "restaurant name, city" } -> { menu, restaurantName, sourceUrl? }
//
// Uses the OpenAI Responses API web_search tool to find the restaurant and its
// current menu anywhere online (official site, PDF, Toast/Square ordering page,
// Yelp/DoorDash/Google listing). Two-stage:
//   1. Search-and-extract: the model browses and returns the menu JSON directly.
//   2. If it only found a menu URL, fetch + parse that URL with the shared
//      pipeline (handles HTML, PDF, images, JS shells).
// If the menu genuinely is not online, returns a plain-language explanation.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchMenuSource,
  parseMenuSource,
  menuItemCount,
  extractJson,
  FriendlyError,
  type ParsedMenu,
} from './_menuCore';

const SEARCH_MODEL = process.env.SEARCH_MODEL ?? 'gpt-5.4-mini';

const FIND_JSON_SHAPE =
  '{"found":boolean,"restaurantName":string|null,"menuUrl":string|null,' +
  '"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],' +
  '"notes":string,"reason":string}';

function buildPrompt(query: string): string {
  return [
    `Find the restaurant "${query}" and its CURRENT food menu online.`,
    'Search the web. Likely sources, in order of preference: the restaurant\'s own website',
    '(menu page or PDF), their online-ordering page (Toast, Square, ChowNow, Clover),',
    'their Google Business listing, or aggregator listings (Yelp, DoorDash, Grubhub).',
    '',
    'Extract EVERY menu item you can actually read from the pages you visit: name,',
    'description, price as written with currency symbol, and a best-effort ingredients',
    'list. Group items into the menu\'s natural sections. NEVER invent items you did not read.',
    '',
    'If you can identify the restaurant but cannot read its full menu, set "categories" to []',
    'and put the single best menu URL you found (prefer a direct menu page or PDF) in "menuUrl".',
    'If you cannot find the restaurant or any menu at all, set found=false and explain briefly',
    'in "reason" (e.g. "I found their website but the menu is not posted online").',
    '',
    `Respond ONLY with JSON matching: ${FIND_JSON_SHAPE}`,
  ].join('\n');
}

/** Concatenate output_text items from a Responses API result. */
function responseText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  let out = '';
  for (const item of data?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') out += part.text;
    }
  }
  return out;
}

async function searchForMenu(query: string): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new FriendlyError('No API key configured on the server.', 500);

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SEARCH_MODEL,
      tools: [{ type: 'web_search' }],
      input: buildPrompt(query),
    }),
    signal: AbortSignal.timeout(50000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[MenuVoice] find-menu search error:', res.status, text.slice(0, 500));
    throw new FriendlyError('The restaurant search is having trouble right now. Please try again in a moment.', 502);
  }
  const data = await res.json();
  return extractJson(responseText(data));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { query } = (req.body ?? {}) as { query?: string };
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query required' });
  }

  try {
    const result = await searchForMenu(query.trim().slice(0, 200));
    const restaurantName: string | null =
      typeof result?.restaurantName === 'string' && result.restaurantName.trim()
        ? result.restaurantName.trim()
        : null;

    // Stage 1: the search model read the menu directly.
    const direct: ParsedMenu = {
      categories: Array.isArray(result?.categories) ? result.categories : [],
      notes: typeof result?.notes === 'string' ? result.notes : undefined,
      restaurantName: restaurantName ?? undefined,
    };
    if (menuItemCount(direct) >= 3) {
      return res.status(200).json({
        menu: direct,
        restaurantName,
        sourceUrl: typeof result?.menuUrl === 'string' ? result.menuUrl : undefined,
        via: 'search',
      });
    }

    // Stage 2: it found a menu URL but couldn't read it — fetch and parse ourselves.
    if (typeof result?.menuUrl === 'string' && /^https?:\/\//i.test(result.menuUrl)) {
      try {
        const source = await fetchMenuSource(result.menuUrl);
        const menu = await parseMenuSource(source);
        if (menuItemCount(menu) > 0) {
          if (!menu.restaurantName && restaurantName) menu.restaurantName = restaurantName;
          return res.status(200).json({ menu, restaurantName: menu.restaurantName ?? restaurantName, sourceUrl: result.menuUrl, via: 'url' });
        }
      } catch (e) {
        console.error('[MenuVoice] find-menu stage-2 fetch failed:', e);
      }
    }

    // Couldn't get a menu. Tell the user the truth about what we found.
    const reason =
      typeof result?.reason === 'string' && result.reason.trim()
        ? result.reason.trim()
        : result?.found
          ? 'I found the restaurant, but their menu does not seem to be posted online.'
          : "I couldn't find that restaurant online. Try adding the city, like 'Luigi's, Bloomington Indiana'.";
    return res.status(404).json({ error: reason, restaurantName });
  } catch (e: any) {
    if (e instanceof FriendlyError) return res.status(e.status).json({ error: e.message });
    console.error('[MenuVoice] find-menu error:', e);
    return res.status(502).json({ error: 'The restaurant search failed. Please try again in a moment.' });
  }
}
