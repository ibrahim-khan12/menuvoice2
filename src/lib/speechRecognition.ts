// Web Speech API wrapper for the conversation listen loop.
//
// Uses the browser's native voice recognition (webkitSpeechRecognition on iOS Safari)
// instead of MediaRecorder + Web Audio VAD. The native implementation has:
// - Built-in silence detection (2s timer submits the transcript automatically)
// - Reliable on iOS Safari (webkitSpeechRecognition works; Web Audio VAD does not)
// - Auto-restart when iOS cuts the session short mid-session

import { track } from './telemetry';

// Minimal types for Web Speech API — not in all TypeScript DOM lib versions.
interface SR {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
}
interface SRResult { transcript: string; confidence: number; }
interface SRResultList { length: number; [index: number]: { isFinal: boolean; [alt: number]: SRResult; length: number; }; }
interface SREvent extends Event { results: SRResultList; resultIndex: number; }
interface SRErrorEvent extends Event { error: string; message: string; }

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition
  );
}

export class SpeechManager {
  private recognition: SR | null = null;
  private shouldRestart = false;
  private lastTranscript = '';
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SILENCE_MS = 2000;

  constructor(
    private onTranscript: (transcript: string) => void,
    private onError: (message: string) => void,
  ) {
    if (!isSpeechRecognitionSupported()) return;
    const Ctor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    this.recognition = new Ctor();
    this.recognition!.continuous = true;
    this.recognition!.interimResults = true;
    this.recognition!.lang = 'en-US';
    this.recognition!.maxAlternatives = 1;
    this.attach();
  }

  private clearSilenceTimer() {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private attach() {
    if (!this.recognition) return;

    this.recognition.onresult = (event: SREvent) => {
      const result = event.results[event.results.length - 1];
      const t = result[0].transcript;
      if (result.isFinal || t.length > 0) {
        this.lastTranscript = t;
        this.clearSilenceTimer();
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          const transcript = this.lastTranscript;
          this.lastTranscript = '';
          this.shouldRestart = false;
          this.recognition?.stop();
          this.onTranscript(transcript);
        }, SpeechManager.SILENCE_MS);
      }
    };

    this.recognition.onerror = (event: SRErrorEvent) => {
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        this.clearSilenceTimer();
        this.shouldRestart = false;
        track('speech', 'stt_error', { outcome: 'failure', metadata: { error: event.error } });
        this.onError(
          'I need microphone access to hear you. Please allow microphone access, then tap Try again.',
        );
      }
    };

    this.recognition.onend = () => {
      if (this.silenceTimer) {
        this.clearSilenceTimer();
        const t = this.lastTranscript;
        if (t) {
          this.lastTranscript = '';
          this.shouldRestart = false;
          this.onTranscript(t);
          return;
        }
      }

      if (this.shouldRestart) {
        this.restartTimeout = setTimeout(() => {
          try { this.recognition?.start(); } catch {}
        }, 300);
      }
    };
  }

  start() {
    this.shouldRestart = true;
    this.lastTranscript = '';
    try { this.recognition?.start(); } catch {}
  }

  stop() {
    this.shouldRestart = false;
    this.clearSilenceTimer();
    if (this.restartTimeout !== null) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.recognition?.stop();
  }

  submitNow() {
    this.clearSilenceTimer();
    const t = this.lastTranscript;
    this.lastTranscript = '';
    this.shouldRestart = false;
    this.recognition?.stop();
    if (t) this.onTranscript(t);
  }

  destroy() {
    this.shouldRestart = false;
    this.clearSilenceTimer();
    if (this.restartTimeout !== null) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.recognition?.abort();
    this.recognition = null;
  }
}

