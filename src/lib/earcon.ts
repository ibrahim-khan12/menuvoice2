// Short audio cues (earcons) for mic start/stop. Generated with the Web Audio
// API — no audio files needed. Low volume so they don't startle.
//
// Reuses the shared AudioContext from audioUnlock so cues actually play on iOS
// (a freshly-created AudioContext is blocked unless made inside a gesture, and
// most earcons fire from timers/callbacks, not taps).

import { getAudioContext } from './audioUnlock';

function play(tones: { freq: number; dur: number; vol?: number }[], delayMs = 0) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    let t = ctx.currentTime + delayMs / 1000;
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      const v = tone.vol ?? 0.18;
      gain.gain.setValueAtTime(v, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tone.dur);
      osc.start(t);
      osc.stop(t + tone.dur + 0.01);
      t += tone.dur + 0.02;
    }
  } catch {}
}

/** Ascending double-ping: mic is now listening. */
export function earconStart() {
  play([{ freq: 660, dur: 0.07 }, { freq: 880, dur: 0.07 }]);
}

/** Single descending ping: mic stopped. */
export function earconStop() {
  play([{ freq: 660, dur: 0.09 }]);
}

/** Short low tone: error or no-match. */
export function earconError() {
  play([{ freq: 300, dur: 0.12, vol: 0.12 }]);
}

/** Rising tick: one step closer to auto-capture. n=current count, max=total. */
export function earconTick(n: number, max: number) {
  const freq = 380 + (n / max) * 640;
  play([{ freq, dur: 0.055, vol: 0.17 }]);
}

/** Shutter click: auto-capture fired. */
export function earconCapture() {
  play([
    { freq: 1100, dur: 0.03, vol: 0.22 },
    { freq: 700,  dur: 0.07, vol: 0.16 },
  ]);
}

// A3 — new turn cues

/** Warm two-tone: app is about to speak. */
export function earconSpeak() {
  play([{ freq: 500, dur: 0.08, vol: 0.14 }, { freq: 660, dur: 0.10, vol: 0.16 }]);
}

let _thinkingTimer: ReturnType<typeof setInterval> | null = null;

/** Start soft repeating pulse (~420 Hz) to signal the app is thinking. */
export function earconThinkingStart() {
  if (_thinkingTimer) return;
  play([{ freq: 420, dur: 0.12, vol: 0.07 }]);
  _thinkingTimer = setInterval(() => {
    play([{ freq: 420, dur: 0.12, vol: 0.07 }]);
  }, 1400);
}

/** Stop the thinking pulse. */
export function earconThinkingStop() {
  if (_thinkingTimer) {
    clearInterval(_thinkingTimer);
    _thinkingTimer = null;
  }
}
