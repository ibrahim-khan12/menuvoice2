// All OpenAI calls.
//
// Routing strategy:
//   - In production (Vercel), calls go to /api/* serverless functions that
//     hold the key server-side. The client never sees OPENAI_API_KEY.
//   - In local dev, if VITE_OPENAI_API_KEY is set in .env the calls go
//     directly to OpenAI (so you don't need a local server).

import { ParsedMenu, UserProfile, ChatTurn, MenuProvenance } from '../types';
import { track } from './telemetry';
import { provenanceSummary } from './provenance';
import { sanitizeMenu } from './menuSanitizer';
import { apiErrorMessage } from './errors';
import { apiUrl } from './apiUrl';
import { Capacitor } from '@capacitor/core';

export { sanitizeMenu } from './menuSanitizer';

const DIRECT_KEY = import.meta.env?.VITE_OPENAI_API_KEY ?? '';
const AUDIO_PROVIDER = import.meta.env?.VITE_AUDIO_PROVIDER ?? 'openai';
const VISION_MODEL = 'gpt-5.4-mini';
const CHAT_MODEL = 'gpt-5.4-mini';
// Latency-optimized TTS by default. `tts-1` starts generating audio markedly
// faster than `tts-1-hd` (which is tuned for quality, not speed) — the right
// trade for a live, back-and-forth voice conversation. Override with
// VITE_TTS_MODEL=tts-1-hd if a warmer voice matters more than responsiveness.
const TTS_MODEL = import.meta.env?.VITE_TTS_MODEL ?? 'tts-1';
const TTS_VOICE_DEFAULT = 'shimmer';

// True when the direct browser→OpenAI path is available (local dev only).
const DIRECT = DIRECT_KEY.startsWith('sk-') && DIRECT_KEY.length > 20;

export function hasApiKey(
  hostname = window.location.hostname,
  native = Capacitor.isNativePlatform(),
): boolean {
  // Always true in production because the proxy holds the key.
  // Capacitor also uses a localhost hostname, but its API requests are routed
  // to the production backend by apiUrl(). Only a real localhost web session
  // needs a direct VITE_OPENAI_API_KEY.
  return DIRECT || native || hostname !== 'localhost';
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
    if (!res.ok) throw new Error(await parseApiError(res));
    return res.json();
  }
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json();
}

async function audioTranscriptions(form: FormData): Promise<any> {
  if (DIRECT && AUDIO_PROVIDER !== 'cartesia') {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: directHeaders(),
      body: form,
    });
    if (!res.ok) throw new Error(await parseApiError(res));
    return res.json();
  }
  const res = await fetch(apiUrl('/api/transcribe'), { method: 'POST', body: form });
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json();
}

async function audioSpeech(body: object): Promise<Blob> {
  if (DIRECT && AUDIO_PROVIDER !== 'cartesia') {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: directHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await parseApiError(res));
    return res.blob();
  }
  // CapacitorHttp patches window.fetch so native requests bypass WebView CORS.
  // Its native bridge is a poor fit for binary Blob responses, though, and can
  // turn a valid MP3 into an unplayable response on iOS. Capacitor preserves the
  // original WebKit fetch as CapacitorWebFetch; use it only for TTS audio. The
  // /api/tts route explicitly allows the exact signed-app origin.
  const nativeWindow = window as Window & { CapacitorWebFetch?: typeof window.fetch };
  const fetchAudio = Capacitor.isNativePlatform() && nativeWindow.CapacitorWebFetch
    ? nativeWindow.CapacitorWebFetch.bind(window)
    : fetch;
  const res = await fetchAudio(apiUrl('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseApiError(res));
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
        'If a photo is unreadable, note it. ' +
        'Set "incomplete" to true if these photos clearly show only PART of the menu. Text cut off at ' +
        'an edge, sections referenced but not pictured, or unreadable areas. Set it to false if the menu appears whole. ' +
        'Respond ONLY with JSON matching this shape: ' +
        '{"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string,"incomplete":boolean}',
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('I had trouble reading the menu that time. Please try once more.');
  }
  // Never trust the model's shape — rebuild only the well-formed parts.
  const menu = sanitizeMenu(parsed);
  if (!menu) {
    throw new Error('I could not find any menu items in those photos. Try again with more light.');
  }
  return menu;
}

/** Recorded audio Blob -> transcript (Whisper). */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'm4a';
  form.append('file', blob, `speech.${ext}`);
  form.append('model', AUDIO_PROVIDER === 'cartesia' ? 'ink-whisper' : 'whisper-1');
  form.append('language', 'en');
  const json = await audioTranscriptions(form);
  return (json.text ?? '').trim();
}

// Ground the model in the SAME structured provenance facts the provenance
// intent-answers use (see lib/provenance.ts), so ordinary conversation never
// contradicts them. Without this, the model has no idea whether the menu came
// from a photo taken in person or a live web search, and can casually claim
// "this is the most up-to-date menu" / "since this was found online" even for
// a menu the guest just photographed off the physical page in front of them.
function sourceNote(menu: ParsedMenu, provenance?: MenuProvenance): string {
  if (!provenance) {
    return '- You do not have verified source details for this menu. Do not claim it was found online, is the most current version, or was recently checked — say you do not have that information if asked.';
  }
  const facts = provenanceSummary(provenance, menu.restaurantName || 'this restaurant');
  const guard =
    provenance.sourceType === 'photo'
      ? ' This menu did NOT come from the internet. Never say things like "since this was found online" or "this is the most up-to-date menu" for it.'
      : ' Do not claim more currency or completeness than these facts support.';
  return `- Known facts about where this menu came from: ${facts}${guard}`;
}

export function buildSystemPrompt(menu: ParsedMenu, profile: UserProfile, provenance?: MenuProvenance): string {
  const allergies = profile.allergies.length ? profile.allergies.join(', ') : 'none on file';
  const dislikes = profile.dislikes.length ? profile.dislikes.join(', ') : 'none on file';
  const cuisines = profile.cuisinesLiked.length ? profile.cuisinesLiked.join(', ') : 'no strong preferences on file';
  const orders = profile.pastOrders.length ? profile.pastOrders.join(', ') : 'none yet';

  return [
    `You are Meet My Menu AI, a warm, calm voice assistant helping ${profile.name || 'a guest'} who is blind or low-vision navigate a restaurant menu by voice.`,
    '',
    'HARD RULES:',
    `- The guest has these ALLERGIES: ${allergies}. Before describing, recommending, or discussing ANY item that contains (or likely contains) one of these allergens, you MUST flag it first, e.g. "Heads up. This may contain shellfish, which is one of your allergies. Want me to continue?"`,
    '- ALLERGEN CONFIDENCE: The ingredient lists in the menu data are best-effort INFERENCES from each dish name and description, NOT confirmed by the restaurant. Never state an inferred ingredient or allergen as a confirmed fact. Say "the restaurant lists X" ONLY if the menu text explicitly declares it; otherwise say "this likely contains X based on the description, but the restaurant does not confirm it." If you have no information about an allergen for an item, say you could not find official allergen information for it. For a listed allergy, never call a dish safe without explicit confirmation, and encourage the guest to confirm with restaurant staff.',
    `- The guest dislikes: ${dislikes}. Cuisines they like: ${cuisines}.`,
    `- Dishes ${profile.name || 'the guest'} has chosen/enjoyed before: ${orders}. When it fits naturally, use these to make recommendations (e.g. "last time you went for the ${profile.pastOrders[0] ?? 'salmon'}, so you might like..."). Don't force it.`,
    profile.hidePrices
      ? '- The guest has hidden prices. Do NOT say prices unless they explicitly ask.'
      : '- Say prices when relevant.',
    '- Keep answers short and conversational. This is spoken aloud. 1-3 sentences unless they ask for detail. No markdown, no bullet symbols, no emoji.',
    '- Never invent items that are not on the menu. If unsure, say so.',
    menu.incomplete
      ? '- This menu capture is INCOMPLETE. Some items or sections are missing. If asked about something not listed, say it may be on a part of the menu that was not captured, and suggest adding more photos.'
      : '',
    '- End most turns with a brief, natural question that keeps the conversation moving.',
    '',
    'MENU SOURCE:',
    sourceNote(menu, provenance),
    '',
    'REMEMBERING THEIR CHOICE:',
    '- Do NOT ask what the guest has decided to order. Many guests are only browsing, comparing dishes, or checking allergens, and a forced question feels intrusive.',
    '- If the guest tells you naturally that they have decided — "I\'ll get the salmon", "let\'s go with the pasta", "remember that I chose the carbonara" — briefly and warmly confirm what you will remember, e.g. "Got it, I\'ll remember the salmon for next time." Keep the confirmation to one short sentence.',
    '- If they never mention a decision, say nothing about it and never nudge them toward picking something before they leave.',
    '',
    'THE MENU (structured JSON):',
    JSON.stringify(menu),
  ].join('\n');
}

export function buildOpeningLine(menu: ParsedMenu): string {
  const names = menu.categories.map((c) => c.name);
  if (names.length === 0) return 'I have your menu, but I could not find any sections. Want to retake the photos?';
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  const sectionWord = names.length === 1 ? 'section' : 'sections';
  const pageCount = menu.pageCount ?? 0;
  const pagePart = pageCount > 0 ? ` across ${pageCount} page${pageCount === 1 ? '' : 's'}` : '';
  // Incomplete warning comes FIRST and stays to one sentence.
  const prefix = menu.incomplete ? "This wasn't a complete menu. " : '';
  return `${prefix}I found ${names.length} ${sectionWord}${pagePart} on this menu: ${list}. Where would you like to start?`;
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
  userText: string,
  provenance?: MenuProvenance,
): Promise<string> {
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(menu, profile, provenance) }];
  for (const t of pruneHistory(history)) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: userText });

  const json = await chatCompletions({ model: CHAT_MODEL, messages, max_completion_tokens: 220 });
  return (json.choices?.[0]?.message?.content ?? "Sorry, I missed that. Could you say it again?").trim();
}

// A1 — sentence-by-sentence streaming reply.
// Calls onDelta with each text chunk as it arrives; returns the full assembled text.
export async function chatReplyStream(
  menu: ParsedMenu,
  profile: UserProfile,
  history: ChatTurn[],
  userText: string,
  onDelta: (delta: string) => void,
  provenance?: MenuProvenance,
): Promise<string> {
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(menu, profile, provenance) }];
  for (const t of pruneHistory(history)) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: userText });

  const body = { model: CHAT_MODEL, messages, max_completion_tokens: 220, stream: true };

  const t0 = Date.now();
  track('ask', 'llm_request', { metadata: { model: CHAT_MODEL, history_len: history.length } });

  let res: Response;
  if (DIRECT) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: directHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  } else {
    res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const status = res.status;
    const errMsg = await parseApiError(res);
    track('ask', 'error', { outcome: 'failure', metadata: { error_code: status, message: errMsg } });
    throw new Error(errMsg);
  }
  if (!res.body) return chatReply(menu, profile, history, userText, provenance);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buf = '';
  let firstToken = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            if (!firstToken) {
              firstToken = true;
              track('ask', 'llm_first_token', { durationMs: Date.now() - t0, metadata: { model: CHAT_MODEL } });
            }
            fullText += delta;
            onDelta(delta);
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }

  const reply = fullText.trim() || "Sorry, I missed that. Could you say it again?";
  track('ask', 'llm_reply', {
    outcome: 'success',
    durationMs: Date.now() - t0,
    content: { text: reply },
    metadata: { model: CHAT_MODEL, est_completion_tokens: Math.ceil(reply.length / 4) },
  });
  return reply;
}

export interface SessionLearnings {
  orders: string[];
  likes: string[];
  dislikes: string[];
}

export async function extractSessionLearnings(turns: ChatTurn[]): Promise<SessionLearnings> {
  const empty: SessionLearnings = { orders: [], likes: [], dislikes: [] };
  const transcript = turns
    .map((t) => `${t.role === 'assistant' ? 'Meet My Menu AI' : 'Guest'}: ${t.text}`)
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
            'orders = ONLY dishes the guest clearly decided on or committed to ordering (e.g. "I\'ll get the salmon", ' +
            '"let\'s go with the pasta", "remember that I chose the carbonara") — exact dish names. ' +
            'Merely asking about a dish, comparing two dishes, or Meet My Menu AI recommending one does NOT count as an ' +
            'order unless the guest then confirmed or agreed to it. If the guest was only browsing or asking ' +
            'questions and never settled on anything, orders MUST be an empty array. ' +
            'likes = foods, cuisines, or ingredients the guest reacted positively to. ' +
            'dislikes = ones they reacted against. Use empty arrays if unclear. Never invent.',
        },
        { role: 'user', content: transcript },
      ],
    });
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? '{}');
    const result = {
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      likes: Array.isArray(parsed.likes) ? parsed.likes : [],
      dislikes: Array.isArray(parsed.dislikes) ? parsed.dislikes : [],
    };
    track('learnings', 'extracted', {
      outcome: 'success',
      content: { orders: result.orders, cuisines_liked: result.likes, dislikes: result.dislikes },
    });
    return result;
  } catch {
    return empty;
  }
}

/** Restaurant website URL -> structured menu. One server call does fetch
 * (HTML / PDF / image, menu-link follow) + GPT extraction. Returns the menu plus
 * provenance (source type, freshness, completeness) so callers can be honest
 * about where it came from. */
export async function parseMenuFromUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ menu: ParsedMenu; provenance?: MenuProvenance; sourceUrl?: string }> {
  const t0 = Date.now();
  const res = await fetch(apiUrl('/api/menu-from-url'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok) {
    const msg = await parseApiError(
      res,
      "I couldn't read the menu from that website. Double-check the link and try again.",
    );
    track('menu', 'parse_url', { outcome: 'failure', durationMs: Date.now() - t0, metadata: { url, status: res.status } });
    throw new Error(msg);
  }
  const data = (await res.json().catch(() => ({}))) as { menu?: unknown; provenance?: MenuProvenance; sourceUrl?: string };
  // Server responses are AI output too — same safety net as photo parsing.
  const menu = sanitizeMenu(data.menu);
  if (!menu) {
    track('menu', 'parse_url', { outcome: 'failure', durationMs: Date.now() - t0, metadata: { url, reason: 'malformed_menu' } });
    throw new Error("I couldn't read a usable menu from that website. Double-check the link and try again.");
  }
  const itemCount = menu.categories.reduce((s, c) => s + c.items.length, 0);
  track('menu', 'parse_url', {
    outcome: 'success',
    durationMs: Date.now() - t0,
    content: { restaurantName: menu.restaurantName, itemCount },
    metadata: { url, sourceType: data.provenance?.sourceType },
  });
  return { menu, provenance: data.provenance, sourceUrl: data.sourceUrl };
}

/** Restaurant NAME (+ city) -> structured menu, via server-side web search.
 * Throws a friendly Error when the menu isn't online. */
export async function findMenuByName(query: string, signal?: AbortSignal): Promise<{ menu: ParsedMenu; restaurantName: string | null; address?: string | null; sourceUrl?: string; provenance?: MenuProvenance }> {
  const t0 = Date.now();
  const res = await fetch(apiUrl('/api/find-menu'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!res.ok) {
    const message = await parseApiError(
      res,
      "I couldn't find that restaurant's menu online. Try adding the city to the name.",
    );
    track('menu', 'find_by_name', {
      outcome: 'failure',
      durationMs: Date.now() - t0,
      metadata: { query, status: res.status },
    });
    throw new Error(message);
  }
  const data = (await res.json().catch(() => ({}))) as {
    menu?: unknown;
    restaurantName?: string | null;
    address?: string | null;
    via?: string;
    sourceUrl?: string;
    provenance?: MenuProvenance;
    error?: string;
  };
  // Sanitize before trusting: the server relays AI output, and a malformed
  // menu must fail with a friendly sentence, never crash the conversation.
  const menu = sanitizeMenu(data.menu);
  if (!menu) {
    track('menu', 'find_by_name', {
      outcome: 'failure',
      durationMs: Date.now() - t0,
      metadata: { query, status: res.status, reason: data.error ?? 'malformed_menu' },
    });
    throw new Error("I couldn't find a usable menu for that restaurant. Try adding the city to the name.");
  }
  const itemCount = menu.categories.reduce((s, c) => s + c.items.length, 0);
  track('menu', 'find_by_name', {
    outcome: 'success',
    durationMs: Date.now() - t0,
    content: { restaurantName: menu.restaurantName ?? data.restaurantName, itemCount },
    metadata: { query, via: data.via, sourceUrl: data.sourceUrl },
  });
  return {
    menu,
    restaurantName: data.restaurantName ?? menu.restaurantName ?? null,
    address: data.address ?? null,
    sourceUrl: data.sourceUrl,
    provenance: data.provenance,
  };
}

/** Text -> mp3 Blob (OpenAI TTS).
 * Retries once on failure: the first request after page load often hits a cold
 * Vercel serverless function that can time out, and we'd rather take a second
 * attempt at the good voice than drop the opening line onto the robotic browser
 * fallback. */
export async function synthesizeSpeech(text: string, voice?: string, speed?: number): Promise<Blob> {
  const body: Record<string, unknown> = {
    model: TTS_MODEL,
    voice: voice || TTS_VOICE_DEFAULT,
    input: text,
    response_format: 'mp3',
  };
  // OpenAI TTS accepts speed 0.25–4.0. Only send it when it differs from normal.
  if (typeof speed === 'number' && speed !== 1) {
    body.speed = Math.max(0.25, Math.min(4, speed));
  }
  try {
    return await audioSpeech(body);
  } catch (e) {
    track('speech', 'tts_retry', { metadata: { reason: e instanceof Error ? e.message : String(e) } });
    return audioSpeech(body);
  }
}

// Users HEAR these messages, so they are plain recovery sentences — never
// status codes, key names, or provider wording. The technical detail is logged
// for developers instead.
async function parseApiError(
  res: Response,
  fallback = 'Something went wrong on my end. Please try again in a moment.',
): Promise<string> {
  let body = '';
  try { body = await res.text(); } catch {}
  console.warn(`Meet My Menu AI API error (technical detail): status ${res.status}`, body.slice(0, 500));
  return apiErrorMessage(res.status, fallback);
}
