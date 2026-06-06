// All OpenAI calls.
//
// Routing strategy:
//   - In production (Vercel), calls go to /api/* serverless functions that
//     hold the key server-side. The client never sees OPENAI_API_KEY.
//   - In local dev, if VITE_OPENAI_API_KEY is set in .env the calls go
//     directly to OpenAI (so you don't need a local server).

import { ParsedMenu, UserProfile, ChatTurn } from '../types';

const DIRECT_KEY = import.meta.env.VITE_OPENAI_API_KEY ?? '';
const VISION_MODEL = 'gpt-5.4-mini';
const CHAT_MODEL = 'gpt-5.4-mini';
const TTS_MODEL = 'tts-1-hd';
const TTS_VOICE_DEFAULT = 'shimmer';

// True when the direct browser→OpenAI path is available (local dev only).
const DIRECT = DIRECT_KEY.startsWith('sk-') && DIRECT_KEY.length > 20;

export function hasApiKey(): boolean {
  // Always true in production because the proxy holds the key.
  // In local dev, true if VITE_OPENAI_API_KEY is set.
  return DIRECT || window.location.hostname !== 'localhost';
}

function directHeaders(extra?: Record<string, string>) {
  return { Authorization: `Bearer ${DIRECT_KEY}`, ...extra };
}

async function chatCompletions(body: object): Promise<any> {
  if (DIRECT) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: directHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI error (${res.status}): ${await safeText(res)}`);
    return res.json();
  }
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server error (${res.status}): ${await safeText(res)}`);
  return res.json();
}

async function audioTranscriptions(form: FormData): Promise<any> {
  if (DIRECT) {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: directHeaders(),
      body: form,
    });
    if (!res.ok) throw new Error(`Transcription error (${res.status}): ${await safeText(res)}`);
    return res.json();
  }
  const res = await fetch('/api/transcribe', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Transcription error (${res.status}): ${await safeText(res)}`);
  return res.json();
}

async function audioSpeech(body: object): Promise<Blob> {
  if (DIRECT) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: directHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TTS error (${res.status}): ${await safeText(res)}`);
    return res.blob();
  }
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TTS error (${res.status}): ${await safeText(res)}`);
  return res.blob();
}

/** Menu photos (base64 JPEG, no data: prefix) -> structured menu. */
export async function parseMenuFromImages(imagesBase64: string[]): Promise<ParsedMenu> {
  const content: any[] = [
    {
      type: 'text',
      text:
        'You are reading photos of one restaurant menu (possibly multiple pages/photos of the SAME menu). ' +
        'Extract EVERY item you can see. Group items into the menu\'s natural sections ' +
        '(appetizers, mains, desserts, drinks, specials, etc.). ' +
        'For each item include: name, description (if shown), price (as written, with currency symbol), ' +
        'and a best-effort ingredients list inferred from the name and description. ' +
        'Also extract the restaurant name if it is visible on the menu (e.g. on the header or cover). ' +
        'If a photo is unreadable, note it. Respond ONLY with JSON matching this shape: ' +
        '{"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string}',
    },
  ];
  for (const b64 of imagesBase64) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } });
  }

  const json = await chatCompletions({
    model: VISION_MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
  });

  const raw = json.choices?.[0]?.message?.content ?? '{}';
  let parsed: ParsedMenu;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The menu reader returned something I could not understand. Try retaking the photos.');
  }
  if (!parsed.categories || parsed.categories.length === 0) {
    throw new Error('I could not find any menu items in those photos. Try again with more light.');
  }
  return parsed;
}

/** Recorded audio Blob -> transcript (Whisper). */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'm4a';
  form.append('file', blob, `speech.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  const json = await audioTranscriptions(form);
  return (json.text ?? '').trim();
}

function buildSystemPrompt(menu: ParsedMenu, profile: UserProfile): string {
  const allergies = profile.allergies.length ? profile.allergies.join(', ') : 'none on file';
  const dislikes = profile.dislikes.length ? profile.dislikes.join(', ') : 'none on file';
  const cuisines = profile.cuisinesLiked.length ? profile.cuisinesLiked.join(', ') : 'no strong preferences on file';
  const orders = profile.pastOrders.length ? profile.pastOrders.join(', ') : 'none yet';

  return [
    `You are MenuVoice, a warm, calm voice assistant helping ${profile.name || 'a guest'} who is blind or low-vision navigate a restaurant menu by voice.`,
    '',
    'HARD RULES:',
    `- The guest has these ALLERGIES: ${allergies}. Before describing, recommending, or discussing ANY item that contains (or likely contains) one of these allergens, you MUST flag it first, e.g. "Heads up — this contains shellfish, which is one of your allergies. Want me to continue?"`,
    `- The guest dislikes: ${dislikes}. Spice tolerance: ${profile.spiceTolerance}. Cuisines they like: ${cuisines}.`,
    `- Dishes ${profile.name || 'the guest'} has chosen/enjoyed before: ${orders}. When it fits naturally, use these to make recommendations (e.g. "last time you went for the ${profile.pastOrders[0] ?? 'salmon'}, so you might like..."). Don't force it.`,
    profile.hidePrices
      ? '- The guest has hidden prices. Do NOT say prices unless they explicitly ask.'
      : '- Say prices when relevant.',
    '- Keep answers short and conversational — this is spoken aloud. 1-3 sentences unless they ask for detail. No markdown, no bullet symbols, no emoji.',
    '- Never invent items that are not on the menu. If unsure, say so.',
    '- End most turns with a brief, natural question that keeps the conversation moving.',
    '',
    'REMEMBERING THEIR CHOICE:',
    '- Near the END of the conversation, once the guest seems to be settling on what to get, ask ONCE what they have decided to order. When they tell you, acknowledge it warmly and let them know you will remember it for next time so you can suggest things they like.',
    '- Ask this only once, and only when they seem ready to decide. Never nag, never interrupt the middle of the conversation to ask, and never repeat the question if they already told you.',
    '',
    'THE MENU (structured JSON):',
    JSON.stringify(menu),
  ].join('\n');
}

export function buildOpeningLine(menu: ParsedMenu): string {
  const names = menu.categories.map((c) => c.name);
  const totalItems = menu.categories.reduce((sum, c) => sum + c.items.length, 0);
  if (names.length === 0) return 'I have your menu, but I could not find any sections. Want to retake the photos?';
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  const sectionWord = names.length === 1 ? 'section' : 'sections';
  const itemPart = totalItems > 0 ? ` and ${totalItems} item${totalItems === 1 ? '' : 's'}` : '';
  return `I found ${names.length} ${sectionWord}${itemPart} on this menu: ${list}. Where would you like to start?`;
}

// Keep the first 2 turns (establishes what was ordered/discussed early on) plus
// the most recent ones so very long sessions don't balloon the payload.
function pruneHistory(history: ChatTurn[], maxTurns = 20): ChatTurn[] {
  if (history.length <= maxTurns) return history;
  const head = history.slice(0, 2);
  const tail = history.slice(-(maxTurns - 2));
  return [...head, ...tail];
}

export async function chatReply(
  menu: ParsedMenu,
  profile: UserProfile,
  history: ChatTurn[],
  userText: string
): Promise<string> {
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(menu, profile) }];
  for (const t of pruneHistory(history)) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: userText });

  const json = await chatCompletions({ model: CHAT_MODEL, messages, max_completion_tokens: 220 });
  return (json.choices?.[0]?.message?.content ?? "Sorry, I missed that. Could you say it again?").trim();
}

export interface SessionLearnings {
  orders: string[];
  likes: string[];
  dislikes: string[];
}

export async function extractSessionLearnings(turns: ChatTurn[]): Promise<SessionLearnings> {
  const empty: SessionLearnings = { orders: [], likes: [], dislikes: [] };
  const transcript = turns
    .map((t) => `${t.role === 'assistant' ? 'MenuVoice' : 'Guest'}: ${t.text}`)
    .join('\n');
  if (!transcript.trim()) return empty;

  try {
    const json = await chatCompletions({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'From this restaurant menu conversation, extract what the GUEST decided. ' +
            'Respond ONLY with JSON: {"orders":string[],"likes":string[],"dislikes":string[]}. ' +
            'orders = specific dishes the guest said they will order or have decided on (exact dish names). ' +
            'likes = foods, cuisines, or ingredients the guest reacted positively to. ' +
            'dislikes = ones they reacted against. Use empty arrays if unclear. Never invent.',
        },
        { role: 'user', content: transcript },
      ],
    });
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? '{}');
    return {
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      likes: Array.isArray(parsed.likes) ? parsed.likes : [],
      dislikes: Array.isArray(parsed.dislikes) ? parsed.dislikes : [],
    };
  } catch {
    return empty;
  }
}

/** Restaurant website URL -> structured menu (scrape then GPT parse). */
export async function parseMenuFromUrl(url: string): Promise<ParsedMenu> {
  const scrapeRes = await fetch('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!scrapeRes.ok) {
    const err = await scrapeRes.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Hey, sorry — I couldn't reach that website. Double-check the link and try again.");
  }

  const data = (await scrapeRes.json()) as { text?: string; imageUrl?: string };

  let content: any;
  if (data.imageUrl) {
    content = [
      {
        type: 'text',
        text:
          'You are reading an image of a restaurant menu. Extract every item you can see. ' +
          'Group items into natural sections (appetizers, mains, desserts, drinks, specials, etc.). ' +
          'For each item include: name, description (if shown), price (as written, with currency symbol), ' +
          'and a best-effort ingredients list. Extract the restaurant name if visible. ' +
          'Respond ONLY with JSON: {"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string}',
      },
      { type: 'image_url', image_url: { url: data.imageUrl, detail: 'high' } },
    ];
  } else {
    const text = data.text;
    if (!text?.trim()) throw new Error("Hey, sorry — that page looks empty to me. Try linking directly to their menu page, like adding /menu to the address.");
    content =
      'You are reading text scraped from a restaurant website. Extract every menu item visible. ' +
      'Group items into natural sections (appetizers, mains, desserts, drinks, specials, etc.). ' +
      'For each item include: name, description (if shown), price (as written, with currency symbol), ' +
      'and a best-effort ingredients list inferred from the name and description. ' +
      'Extract the restaurant name if visible. ' +
      'If no menu items are found, set categories to an empty array. ' +
      'Respond ONLY with JSON: {"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string}\n\n' +
      'WEBSITE TEXT:\n' + text;
  }

  const json = await chatCompletions({
    model: VISION_MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
  });

  const raw = json.choices?.[0]?.message?.content ?? '{}';
  let parsed: ParsedMenu;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Hey, sorry — something went wrong reading that menu. Try a different link.");
  }
  if (!parsed.categories || parsed.categories.length === 0) {
    throw new Error(
      "Hey, sorry — I couldn't find any menu items on that page. It might be the homepage rather than the menu itself. Try adding /menu to the address, or find a link that goes directly to their food menu."
    );
  }
  return parsed;
}

/** Text -> mp3 Blob (OpenAI TTS). */
export async function synthesizeSpeech(text: string, voice?: string): Promise<Blob> {
  return audioSpeech({
    model: TTS_MODEL,
    voice: voice || TTS_VOICE_DEFAULT,
    input: text,
    response_format: 'mp3',
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
