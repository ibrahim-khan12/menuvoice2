// Web Speech API wrapper for the conversation listen loop.
//
// Uses the browser's native voice recognition (webkitSpeechRecognition on iOS Safari)
// instead of MediaRecorder + Web Audio VAD. The native implementation has:
// - Built-in silence detection (2s timer submits the transcript automatically)
// - Reliable on iOS Safari (webkitSpeechRecognition works; Web Audio VAD does not)
// - Auto-restart when iOS cuts the session short mid-session

import { track } from './telemetry';

const STT_PROVIDER = import.meta.env.VITE_STT_PROVIDER ?? 'browser';
const CARTESIA_VERSION = '2026-03-01';

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
  if (
    STT_PROVIDER === 'cartesia' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof WebSocket !== 'undefined' &&
    !!((window as any).AudioContext || (window as any).webkitAudioContext)
  ) {
    return true;
  }
  return !!(
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition
  );
}

export class SpeechManager {
  private recognition: SR | null = null;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private usingCartesia = false;
  private shouldRestart = false;
  private lastTranscript = '';
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  // Wait this long after the guest stops talking before submitting their turn.
  // Kept generous on purpose: cutting a blind guest off mid-thought is far worse
  // than a slightly late submit, so we tolerate natural pauses.
  private static readonly SILENCE_MS = 2000;

  constructor(
    private onTranscript: (transcript: string) => void,
    private onError: (message: string) => void,
  ) {
    this.usingCartesia = STT_PROVIDER === 'cartesia';
    if (this.usingCartesia) return;
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
    if (this.usingCartesia) {
      this.startCartesia().catch((error) => {
        console.warn('Cartesia realtime STT failed:', error);
        track('speech', 'stt_error', {
          outcome: 'failure',
          metadata: { provider: 'cartesia', error: error?.message ?? String(error) },
        });
        this.onError('I had trouble starting the microphone. Please try again.');
      });
      return;
    }
    this.shouldRestart = true;
    this.lastTranscript = '';
    try { this.recognition?.start(); } catch {}
  }

  stop() {
    if (this.usingCartesia) {
      this.stopCartesia(false);
      return;
    }
    this.shouldRestart = false;
    this.clearSilenceTimer();
    if (this.restartTimeout !== null) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.recognition?.stop();
  }

  submitNow() {
    if (this.usingCartesia) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'close' }));
      } else if (this.lastTranscript) {
        const t = this.lastTranscript;
        this.lastTranscript = '';
        this.onTranscript(t);
      }
      return;
    }
    this.clearSilenceTimer();
    const t = this.lastTranscript;
    this.lastTranscript = '';
    this.shouldRestart = false;
    this.recognition?.stop();
    if (t) this.onTranscript(t);
  }

  destroy() {
    if (this.usingCartesia) {
      this.stopCartesia(false);
      return;
    }
    this.shouldRestart = false;
    this.clearSilenceTimer();
    if (this.restartTimeout !== null) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.recognition?.abort();
    this.recognition = null;
  }

  private async startCartesia() {
    this.stopCartesia(false);
    this.lastTranscript = '';
    const tokenRes = await fetch('/api/transcribe?cartesiaToken=1', { method: 'POST' });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const tokenData = await tokenRes.json();
    const token = tokenData?.token;
    if (!token) throw new Error('No Cartesia access token returned.');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioCtor() as AudioContext;
    this.audioContext = audioContext;
    await audioContext.resume();

    const url = new URL('wss://api.cartesia.ai/stt/turns/websocket');
    url.searchParams.set('model', 'ink-2');
    url.searchParams.set('encoding', 'pcm_s16le');
    url.searchParams.set('sample_rate', String(audioContext.sampleRate));
    url.searchParams.set('cartesia_version', CARTESIA_VERSION);
    url.searchParams.set('access_token', token);

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (event) => this.handleCartesiaMessage(event.data);
    this.ws.onerror = () => {
      track('speech', 'stt_error', { outcome: 'failure', metadata: { provider: 'cartesia', error: 'websocket' } });
    };
    this.ws.onclose = () => this.stopCartesia(false);

    const source = audioContext.createMediaStreamSource(this.stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    this.source = source;
    this.processor = processor;
    processor.onaudioprocess = (event) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      this.ws.send(floatToPcm16(input));
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
  }

  private handleCartesiaMessage(raw: any) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'turn.start') {
      track('speech', 'stt_turn_start', { metadata: { provider: 'cartesia' } });
      return;
    }
    if (msg.type === 'turn.update' || msg.type === 'turn.eager_end') {
      if (typeof msg.transcript === 'string') this.lastTranscript = msg.transcript;
      return;
    }
    if (msg.type === 'turn.end') {
      const transcript = typeof msg.transcript === 'string' ? msg.transcript.trim() : this.lastTranscript.trim();
      this.lastTranscript = '';
      this.stopCartesia(false);
      if (transcript) this.onTranscript(transcript);
      return;
    }
    if (msg.type === 'error') {
      track('speech', 'stt_error', {
        outcome: 'failure',
        metadata: { provider: 'cartesia', error: msg.message ?? msg.title ?? 'error' },
      });
      this.stopCartesia(false);
      this.onError('I had trouble hearing you. Please try again.');
    }
  }

  private stopCartesia(sendClose: boolean) {
    if (sendClose && this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'close' })); } catch {}
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
