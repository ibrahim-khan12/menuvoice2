// Text-to-speech playback. Prefers OpenAI TTS (warm voice); falls back to the
// browser's built-in speechSynthesis when there's no key or the call fails.

import { synthesizeSpeech, hasApiKey } from './openai';
import { track } from './telemetry';

const AUDIO_PROVIDER = import.meta.env.VITE_AUDIO_PROVIDER ?? 'openai';
const TTS_FALLBACK_TIMEOUT_MS = 4000;

// Monotonic counter. stopSpeaking() increments it, invalidating every in-flight
// playback path in one atomic move — structural guarantee against overlap.
let speechEpoch = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let settleCurrent: (() => void) | null = null;
let _speaking = false;

// Global app-voice gate. When off, the app's own TTS stays silent so it does
// not talk over VoiceOver. Initialized from the saved profile.
let _appVoiceOn = true;
try {
  const raw = localStorage.getItem('menuvoice.profile.v1');
  if (raw) {
    const p = JSON.parse(raw);
    if (p && p.appVoice === false) _appVoiceOn = false;
  }
} catch {}

export function setAppVoice(on: boolean) {
  _appVoiceOn = on;
  if (!on) stopSpeaking();
}

export function isAppVoiceOn(): boolean {
  return _appVoiceOn;
}

export function isSpeaking(): boolean {
  return _speaking;
}

export function stopSpeaking(reason?: 'bargein') {
  speechEpoch++;
  if (_speaking && reason === 'bargein') {
    track('speech', 'bargein', {});
  }
  _speaking = false;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  if (settleCurrent) {
    const s = settleCurrent;
    settleCurrent = null;
    s();
  }
  try { window.speechSynthesis?.cancel(); } catch {}
}

async function playBlob(blob: Blob, epoch: number): Promise<void> {
  if (epoch !== speechEpoch) return;
  const url = URL.createObjectURL(blob);
  currentUrl = url;
  const audio = new Audio(url);
  currentAudio = audio;
  _speaking = true;

  try {
    await new Promise<void>((resolve, reject) => {
      settleCurrent = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio element error'));
      audio.play().catch(reject);
    });
  } finally {
    _speaking = false;
    if (settleCurrent) settleCurrent = null;
    if (currentUrl === url) { URL.revokeObjectURL(url); currentUrl = null; }
    if (currentAudio === audio) currentAudio = null;
  }
}

// Keep a window-level reference to prevent iOS Safari from GC'ing the utterance.
const _win = window as Window & { _mvUtterance?: SpeechSynthesisUtterance };

async function playBrowser(text: string, epoch: number): Promise<void> {
  if (epoch !== speechEpoch) return;
  return new Promise<void>((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    _win._mvUtterance = u;
    _speaking = true;
    u.onend = () => { _speaking = false; _win._mvUtterance = undefined; resolve(); };
    u.onerror = () => { _speaking = false; _win._mvUtterance = undefined; resolve(); };
    window.speechSynthesis.speak(u);
  });
}

async function playUtterance(text: string, voice: string | undefined, epoch: number): Promise<void> {
  if (!text.trim() || epoch !== speechEpoch) return;
  const t0 = Date.now();
  track('speech', 'tts_start', { metadata: { text_len: text.length, voice: voice ?? 'default' } });
  if (hasApiKey()) {
    try {
      const blob = await synthesizeSpeechWithFallbackTimeout(text, voice);
      if (epoch !== speechEpoch) return;
      await playBlob(blob, epoch);
      track('speech', 'tts_end', { outcome: 'success', durationMs: Date.now() - t0 });
      return;
    } catch (e) {
      console.warn('OpenAI TTS failed, falling back to browser voice:', e);
      track('speech', 'tts_fallback', { metadata: { reason: 'openai_failed' } });
    }
  } else {
    track('speech', 'tts_fallback', { metadata: { reason: 'no_api_key' } });
  }
  await playBrowser(text, epoch);
  track('speech', 'tts_end', { outcome: 'success', durationMs: Date.now() - t0, metadata: { via: 'browser' } });
}

function synthesizeSpeechWithFallbackTimeout(text: string, voice?: string): Promise<Blob> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('tts timeout')), TTS_FALLBACK_TIMEOUT_MS);
  });

  return Promise.race([synthesizeSpeech(text, voice), timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function prefetchSpeech(text: string, voice?: string): Promise<Blob | null> {
  return synthesizeSpeechWithFallbackTimeout(text, voice).catch(() => null);
}

export async function speak(text: string, voice?: string): Promise<void> {
  stopSpeaking();
  if (!_appVoiceOn) return;
  if (!text.trim()) return;
  const myEpoch = speechEpoch;
  await playUtterance(text, voice, myEpoch);
}

// First-response path for menu entry. It speaks with the local browser voice so
// the user hears guidance immediately instead of waiting on a remote TTS fetch.
export async function speakImmediately(text: string): Promise<void> {
  stopSpeaking();
  if (!_appVoiceOn) return;
  if (!text.trim()) return;
  const myEpoch = speechEpoch;
  const t0 = Date.now();
  track('speech', 'tts_start', { metadata: { text_len: text.length, voice: 'browser-immediate' } });
  await playBrowser(text, myEpoch);
  track('speech', 'tts_end', {
    outcome: 'success',
    durationMs: Date.now() - t0,
    metadata: { via: 'browser-immediate' },
  });
}

// Instant, free, local speech for real-time coaching (capture screen).
// Silenced if the main TTS (speak()) is active.
// iOS Safari silently drops an utterance queued in the same tick as cancel(),
// so the speak is deferred one beat after the cancel.
let _coachTimer: ReturnType<typeof setTimeout> | null = null;
export function coach(text: string) {
  if (!_appVoiceOn) return;
  if (_speaking) return;
  track('speech', 'coach', { content: { text } });
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    if (_coachTimer) clearTimeout(_coachTimer);
    _coachTimer = setTimeout(() => {
      _coachTimer = null;
      if (_speaking) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    }, 60);
  } catch {}
}

export function stopCoach() {
  if (_coachTimer) {
    clearTimeout(_coachTimer);
    _coachTimer = null;
  }
  try { window.speechSynthesis?.cancel(); } catch {}
}

// A2 — streaming speech

// Extract complete sentences (ending with .!?) from the front of text.
// Returns [completeSentences, remainder].
function extractComplete(text: string): [string[], string] {
  const re = /[^.!?]*[.!?]+\s*/g;
  const sentences: string[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const s = match[0].trim();
    if (s) sentences.push(s);
    lastEnd = match.index + match[0].length;
  }
  if (sentences.length === 0) return [[], text];
  return [sentences, text.slice(lastEnd)];
}

export function splitSentences(text: string): string[] {
  const [sentences, remainder] = extractComplete(text);
  const all = [...sentences];
  if (remainder.trim()) all.push(remainder.trim());
  return all;
}

export interface StreamingSpeechHandle {
  push(delta: string): void;
  finish(): Promise<void>;
}

export function createStreamingSpeech(
  voice?: string,
  opts?: { onSpeakingStart?: () => void },
): StreamingSpeechHandle {
  stopSpeaking();
  if (!_appVoiceOn) {
    return {
      push() {},
      finish: async () => {},
    };
  }

  // Capture epoch at creation. Any stopSpeaking() call after this point
  // increments speechEpoch, making myEpoch !== speechEpoch — drain bails out.
  const myEpoch = speechEpoch;

  if (AUDIO_PROVIDER === 'cartesia') {
    let fullText = '';
    let spoken = false;
    return {
      push(delta: string) {
        if (myEpoch !== speechEpoch) return;
        fullText += delta;
      },
      async finish() {
        if (myEpoch !== speechEpoch || spoken) return;
        spoken = true;
        const text = fullText.trim();
        if (!text) return;
        opts?.onSpeakingStart?.();
        await playUtterance(text, voice, myEpoch);
      },
    };
  }

  let buffer = '';
  let cancelled = false;
  let firstSpoken = false;
  const queue: string[] = [];
  let draining = false;
  let drainDone: (() => void) | null = null;

  // Prefetch: TTS request started in parallel with the previous sentence playing.
  let prefetchedBlob: Promise<Blob | null> | null = null;
  let prefetchedFor: string | null = null;

  function startPrefetch(text: string) {
    if (!hasApiKey() || prefetchedFor === text) return;
    prefetchedFor = text;
    prefetchedBlob = prefetchSpeech(text, voice);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length > 0 && !cancelled) {
      if (myEpoch !== speechEpoch) { cancelled = true; break; }
      const sentence = queue.shift()!;

      if (!firstSpoken) {
        firstSpoken = true;
        opts?.onSpeakingStart?.();
      }

      // Kick off TTS for the next sentence NOW so it runs while this one plays.
      if (queue.length > 0) startPrefetch(queue[0]);

      if (hasApiKey()) {
        try {
          let blob: Blob;
          if (prefetchedFor === sentence && prefetchedBlob) {
            const prefetched = await prefetchedBlob;
            prefetchedBlob = null;
            prefetchedFor = null;
            if (!prefetched) throw new Error('prefetched TTS unavailable');
            blob = prefetched;
          } else {
            blob = await synthesizeSpeechWithFallbackTimeout(sentence, voice);
          }
          if (myEpoch !== speechEpoch) { cancelled = true; break; }
          await playBlob(blob, myEpoch);
          if (myEpoch !== speechEpoch) { cancelled = true; break; }
          continue;
        } catch (e) {
          console.warn('OpenAI TTS failed, falling back to browser voice:', e);
        }
      }
      if (myEpoch !== speechEpoch) { cancelled = true; break; }
      await playBrowser(sentence, myEpoch);
    }
    draining = false;
    if (drainDone) {
      const cb = drainDone;
      drainDone = null;
      cb();
    }
  }

  function push(delta: string) {
    if (cancelled || myEpoch !== speechEpoch) return;
    buffer += delta;
    const [sentences, remainder] = extractComplete(buffer);
    if (sentences.length > 0) {
      buffer = remainder;
      // Prefetch the first new sentence immediately — before drain() even starts.
      if (!prefetchedBlob && sentences[0]) startPrefetch(sentences[0]);
      queue.push(...sentences);
      drain();
    } else if (buffer.length > 120) {
      // Long clause with no sentence-ending punctuation yet — split at last comma.
      const lastComma = buffer.lastIndexOf(',');
      if (lastComma > 40) {
        const chunk = buffer.slice(0, lastComma + 1).trim();
        buffer = buffer.slice(lastComma + 1).trimStart();
        if (chunk) {
          if (!prefetchedBlob) startPrefetch(chunk);
          queue.push(chunk);
          drain();
        }
      }
    }
  }

  function finish(): Promise<void> {
    if (myEpoch !== speechEpoch) return Promise.resolve();
    if (buffer.trim()) { queue.push(buffer.trim()); buffer = ''; }
    if (cancelled || (queue.length === 0 && !draining)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainDone = resolve;
      drain();
    });
  }

  return { push, finish };
}
