// Text-to-speech playback. Prefers OpenAI TTS (warm voice); falls back to the
// browser's built-in speechSynthesis when there's no key or the call fails.

import { synthesizeSpeech, hasApiKey } from './openai';
import { track } from './telemetry';

// Monotonic counter. stopSpeaking() increments it, invalidating every in-flight
// playback path in one atomic move — structural guarantee against overlap.
let speechEpoch = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let settleCurrent: (() => void) | null = null;
let _speaking = false;

// One persistent <audio> element reused for ALL playback. This is the crux of
// the mobile-autoplay fix: iOS Safari unlocks audio PER ELEMENT, and only when
// play() is first called inside (or just after) a user gesture. The opening line
// plays fine because it follows the navigation tap, but a fresh `new Audio()`
// created later — after the mic auto-submits on silence, with no recent gesture
// — is NOT unlocked and its play() is silently rejected. That's the reported
// symptom: the reply text streams to the screen but is never spoken. Reusing the
// single element that was already unlocked makes every later reply play.
let _audioEl: HTMLAudioElement | null = null;
let _audioUnlocked = false;
let _ttsPrimed = false;

// A valid, completely silent WAV (zero-length data chunk). Playing it inside a
// user gesture unlocks the shared element without making any sound.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

function getAudioEl(): HTMLAudioElement {
  if (!_audioEl) {
    _audioEl = new Audio();
    _audioEl.preload = 'auto';
  }
  return _audioEl;
}

// Call from a real user gesture (button tap, screen tap). Primes the shared
// audio element and speechSynthesis so later gesture-less playback (the reply
// after a silence auto-submit) is allowed. Idempotent, never interrupts active
// speech, and harmless when the browser doesn't gate autoplay.
export function unlockAudio() {
  if (_speaking) return;
  if (!_audioUnlocked) {
    try {
      const el = getAudioEl();
      el.src = SILENT_WAV;
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { try { el.pause(); el.currentTime = 0; } catch {} _audioUnlocked = true; })
         .catch(() => {});
      } else {
        _audioUnlocked = true;
      }
    } catch {}
  }
  if (!_ttsPrimed) {
    try {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
        _ttsPrimed = true;
      }
    } catch {}
  }
}

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
  // Reuse the one persistent, gesture-unlocked element rather than a fresh
  // `new Audio()` (which iOS would treat as locked outside a gesture).
  const audio = getAudioEl();
  currentAudio = audio;
  _speaking = true;

  try {
    await new Promise<void>((resolve, reject) => {
      settleCurrent = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio element error'));
      audio.src = url;
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

// Best browser voice picker. The OS default is often a robotic low-quality voice
// (e.g. Microsoft David on Windows, the basic Android voice). When we have to use
// the browser voice — fallback or local coaching — we want the highest-quality
// English voice available so it never sounds robotic on load.
let _pickedVoice: SpeechSynthesisVoice | null = null;
let _voicesReady = false;

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  let score = 0;
  // High-quality / neural voices across platforms.
  if (name.includes('natural')) score += 100;       // Edge/Windows "(Natural)" voices
  if (name.includes('google')) score += 70;         // Chrome/Android network voices
  if (name.includes('premium') || name.includes('enhanced')) score += 60; // macOS/iOS
  if (name.includes('samantha')) score += 45;       // good macOS/iOS default
  if (/\b(aria|jenny|guy|ana)\b/.test(name)) score += 40; // good Windows online voices
  if (name.includes('zira')) score += 20;
  // Prefer US then other English locales.
  if (v.lang === 'en-US') score += 10;
  else if (v.lang.startsWith('en')) score += 5;
  // Avoid novelty/eSpeak voices that sound robotic.
  if (/\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|espeak|good news|jester|organ|trinoids|whisper|wobble|zarvox)\b/.test(name)) {
    score -= 100;
  }
  return score;
}

function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;
  _voicesReady = true;
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = english.length ? english : voices;
  _pickedVoice = pool.reduce((best, v) => (scoreVoice(v) > scoreVoice(best) ? v : best), pool[0]);
}

// Voices load asynchronously; populate as soon as they're available so the very
// first browser utterance (e.g. an opening-line fallback) already has the good voice.
if ('speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

function applyBestVoice(u: SpeechSynthesisUtterance) {
  if (!_voicesReady) refreshVoices();
  if (_pickedVoice) {
    u.voice = _pickedVoice;
    u.lang = _pickedVoice.lang;
  }
}

async function playBrowser(text: string, epoch: number): Promise<void> {
  if (epoch !== speechEpoch) return;
  return new Promise<void>((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    applyBestVoice(u);
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
      const blob = await synthesizeSpeech(text, voice);
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

export async function speak(text: string, voice?: string): Promise<void> {
  stopSpeaking();
  if (!_appVoiceOn) return;
  if (!text.trim()) return;
  const myEpoch = speechEpoch;
  await playUtterance(text, voice, myEpoch);
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
      applyBestVoice(u);
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
  // Capture epoch at creation. Any stopSpeaking() call after this point
  // increments speechEpoch, making myEpoch !== speechEpoch — drain bails out.
  const myEpoch = speechEpoch;

  // Both OpenAI and Cartesia stream sentence-by-sentence below: the first
  // sentence starts playing as soon as it lands while the rest is still being
  // synthesized in parallel (prefetch). This is the lowest time-to-first-audio
  // path — speaking the whole reply as one clip would force the user to wait for
  // the entire LLM response before hearing anything.
  let buffer = '';
  let cancelled = false;
  let firstSpoken = false;
  const queue: string[] = [];
  let draining = false;
  let drainDone: (() => void) | null = null;

  // Prefetch: TTS request started in parallel with the previous sentence playing.
  let prefetchedBlob: Promise<Blob> | null = null;
  let prefetchedFor: string | null = null;

  function startPrefetch(text: string) {
    if (!hasApiKey() || prefetchedFor === text) return;
    prefetchedFor = text;
    prefetchedBlob = synthesizeSpeech(text, voice);
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
            blob = await prefetchedBlob;
            prefetchedBlob = null;
            prefetchedFor = null;
          } else {
            blob = await synthesizeSpeech(sentence, voice);
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
