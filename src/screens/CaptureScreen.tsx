// Menu capture (web). Live camera preview with AUTO-SHUTTER + audio coaching,
// plus a manual shutter, multi-photo, library upload, then AI analysis.
//
// Auto mode (default): src/lib/autocapture.ts watches the video for
// brightness + content + steadiness and fires on its own while coaching by
// voice. Manual mode: tap Capture. Both add to the same photo list.
//
// Voice commands (after ≥1 photo captured): "analyze" / "done" → analyze,
// "another" / "more" → capture another, "cancel" / "back" → cancel.

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { speak, coach, stopCoach } from '../lib/speech';
import { startCamera, stopCamera, captureFrame, compressImage, enableTorch, disableTorch } from '../lib/camera';
import { parseMenuFromImages, hasApiKey } from '../lib/openai';
import { saveRestaurant } from '../lib/storage';
import { AutoCaptureController, AutoCaptureState } from '../lib/autocapture';
import { useVoiceNav } from '../hooks/useVoiceNav';
import { startRecording, stopRecording, requestMicPermission } from '../lib/recorder';
import { transcribeAudio } from '../lib/openai';
import { earconTick, earconCapture } from '../lib/earcon';

export default function CaptureScreen({ navigate, goBack }: ScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoRef = useRef<AutoCaptureController | null>(null);
  const analyzingRef = useRef(false);
  const captureStateRef = useRef<AutoCaptureState>('content');
  const prevSteadyRef = useRef(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [photos, setPhotos] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [nameRecState, setNameRecState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [status, setStatus] = useState('Starting camera…');
  const [camError, setCamError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [captureStateDraw, setCaptureStateDraw] = useState<AutoCaptureState>('content');
  const [flash, setFlash] = useState(false);

  // Voice commands available once at least one photo has been captured.
  const photosRef = useRef<string[]>([]);
  const { phase: voicePhase, listen: voiceListen, finish: voiceDone } = useVoiceNav({
    commands: [
      { id: 'analyze', keywords: ['analyze', 'analyse', 'done', 'finish', 'go', 'read', 'process'] },
      { id: 'another', keywords: ['another', 'more', 'next', 'page', 'additional'] },
      { id: 'cancel',  keywords: ['cancel', 'back', 'stop', 'exit', 'never mind', 'nevermind'] },
      { id: 'manual',  keywords: ['capture', 'take', 'photo', 'shoot', 'snap'] },
    ],
    onCommand: async (id) => {
      if (id === 'analyze') { analyze(); }
      else if (id === 'another') { addPhoto(captureFrame(videoRef.current!), false); }
      else if (id === 'manual') { manualCapture(); }
      else if (id === 'cancel') { goBack(); }
    },
    onNoMatch: () =>
      `Say "analyze" to read the menu, "another" for another photo, or "cancel" to go back.`,
  });

  const drawOverlay = (state: AutoCaptureState, steady: number, max: number) => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (state === 'disarmed') return;

    let r = 255, g = 255, b = 255;
    if (state === 'dark' || state === 'content') { r = 255; g = 75; b = 75; }
    else if (state === 'moving') { r = 255; g = 195; b = 40; }
    else if (state === 'steadying') {
      const t = steady / max;
      r = Math.round(80 + (1 - t) * 120);
      g = 235;
      b = Math.round(80 + t * 100);
    }

    ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const len = Math.min(w, h) * 0.14;
    const m = 18;
    const brackets: [number, number, number, number, number, number][] = [
      [m, m, m + len, m, m, m + len],
      [w - m, m, w - m - len, m, w - m, m + len],
      [m, h - m, m + len, h - m, m, h - m - len],
      [w - m, h - m, w - m - len, h - m, w - m, h - m - len],
    ];
    for (const [x1, y1, x2, y2, x3, y3] of brackets) {
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x3, y3);
      ctx.stroke();
    }

    if (state === 'steadying' && steady > 0) {
      const cx = w / 2, cy = h / 2, radius = Math.min(w, h) * 0.1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (steady / max) * 2 * Math.PI);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.92)`;
      ctx.lineWidth = 6;
      ctx.stroke();
    }
  };

  // Start / stop camera.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (videoRef.current) {
          const s = await startCamera(videoRef.current);
          if (cancelled) {
            stopCamera(s);
            return;
          }
          streamRef.current = s;
          setCameraReady(true);
          enableTorch(s); // no-op on iOS; improves lighting on Android
        }
      } catch {
        setCamError(
          'Camera unavailable. On iPhone, open this site over HTTPS and allow camera access. You can still upload photos.'
        );
      }
    })();
    return () => {
      cancelled = true;
      autoRef.current?.stop();
      stopCoach();
      if (streamRef.current) disableTorch(streamRef.current);
      stopCamera(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  // Run / stop the auto-capture controller based on mode + state.
  useEffect(() => {
    const active = autoMode && cameraReady && !analyzing && !camError;
    if (!active) {
      autoRef.current?.stop();
      stopCoach();
      return;
    }
    if (!autoRef.current) autoRef.current = new AutoCaptureController();
    speak('Auto capture is on. Hold the phone over the menu and I will take the photo. If I am taking too long, tap the Override button.');
    setStatus('Auto capture on. Hold your phone over the menu.');
    autoRef.current.start(videoRef.current!, {
      onCoach: (msg) => {
        setStatus(msg);
        coach(msg);
      },
      onCapture: () => {
        addPhoto(captureFrame(videoRef.current!), true);
        autoRef.current?.acknowledgeCapture();
      },
      onStruggle: () => {
        setAutoMode(false);
        const msg = 'Auto capture is having trouble. Switching to manual — tap the Capture button when you are ready.';
        setStatus('Switched to manual. Tap "Capture photo" to take the shot.');
        speak(msg);
      },
      onProgress: (state, steady, max) => {
        drawOverlay(state, steady, max);
        if (state !== captureStateRef.current) {
          captureStateRef.current = state;
          setCaptureStateDraw(state);
        }
        if (state === 'steadying' && steady > prevSteadyRef.current) {
          earconTick(steady, max);
        }
        prevSteadyRef.current = state === 'steadying' ? steady : 0;
      },
    });
    return () => {
      autoRef.current?.stop();
      stopCoach();
      const canvas = overlayRef.current;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode, cameraReady, analyzing, camError]);

  const addPhoto = (b64: string | null, viaAuto: boolean) => {
    if (!b64) {
      if (!viaAuto) announce('That photo did not capture. Try again.');
      return;
    }
    if (viaAuto) {
      earconCapture();
      setFlash(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(false), 280);
    }
    setPhotos((prev) => {
      const next = [...prev, b64];
      photosRef.current = next;
      const msg = `Got it. Photo ${next.length} captured. ${
        viaAuto
          ? 'Move to the next page, or tap Done. You can also say "analyze" or "another".'
          : 'Take another, or tap Done to analyze. You can also say "analyze" or "another".'
      }`;
      setStatus(msg);
      if (viaAuto) coach(`Photo ${next.length} captured. Say analyze or another.`);
      else speak(msg);
      return next;
    });
  };

  const announce = (msg: string) => {
    setStatus(msg);
    speak(msg);
  };

  const manualCapture = () => {
    if (analyzing || !videoRef.current) return;
    addPhoto(captureFrame(videoRef.current), false);
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    e.target.value = '';

    announce(`Processing ${files.length} photo${files.length > 1 ? 's' : ''}…`);

    const results = await Promise.allSettled(files.map((f) => compressImage(f)));
    const added: string[] = [];
    const failedNames: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        added.push(r.value);
      } else {
        failedNames.push(files[i].name);
      }
    });

    if (added.length) {
      setPhotos((prev) => {
        const next = [...prev, ...added];
        photosRef.current = next;
        let msg = `Added ${added.length} photo${added.length > 1 ? 's' : ''}. ${next.length} total.`;
        if (failedNames.length) {
          msg += ` ${failedNames.length} could not be read — use JPEG or PNG.`;
        }
        announce(msg);
        return next;
      });
    } else {
      const errMsg =
        failedNames.length === 1
          ? `Could not read "${failedNames[0]}". Use a JPEG or PNG photo.`
          : `Could not read ${failedNames.length} files. Use JPEG or PNG photos.`;
      announce(errMsg);
    }
  };

  const speakName = async () => {
    if (nameRecState !== 'idle') return;
    const ok = await requestMicPermission();
    if (!ok) { announce('Microphone access needed. Allow it and try again.'); return; }
    try {
      await startRecording();
      setNameRecState('recording');
    } catch {
      announce('Could not start microphone. Try typing the name instead.');
    }
  };

  const stopSpeakName = async () => {
    if (nameRecState !== 'recording') return;
    setNameRecState('working');
    let blob: Blob | null = null;
    try { blob = await stopRecording(); } catch {}
    if (!blob) { setNameRecState('idle'); return; }
    try {
      const text = await transcribeAudio(blob);
      if (text) setName(text.replace(/^(it'?s?|this is|the restaurant is|called?)\s+/i, '').replace(/[.!?]+$/, '').trim());
    } catch {}
    setNameRecState('idle');
  };

  const analyze = async () => {
    if (photos.length === 0) {
      announce('Capture at least one photo of the menu first.');
      return;
    }
    if (!hasApiKey()) {
      announce('No API key configured. Set OPENAI_API_KEY in Vercel environment variables.');
      return;
    }
    analyzingRef.current = true;
    setAnalyzing(true);
    autoRef.current?.stop();
    stopCoach();
    announce('Reading the menu. This takes a few seconds.');
    try {
      const menu = await parseMenuFromImages(photos);
      // Use typed/spoken name, fall back to what the AI extracted, then generic.
      const restaurantName = name.trim() || menu.restaurantName?.trim() || 'This restaurant';
      if (!name.trim() && menu.restaurantName) setName(menu.restaurantName);
      await saveRestaurant(restaurantName, menu).catch(() => {});
      stopCamera(streamRef.current);
      navigate({ name: 'conversation', menu, restaurantName });
    } catch (e: any) {
      announce(e?.message ?? 'I could not read the menu. Try retaking the photos with more light.');
      setAnalyzing(false);
      analyzingRef.current = false;
    }
  };

  return (
    <Screen>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Title>Capture menu</Title>
        <div
          className="card"
          style={{ padding: '8px 16px' }}
          aria-label={`${photos.length} photo${photos.length === 1 ? '' : 's'} captured`}
        >
          <strong style={{ fontSize: 22 }}>{photos.length} photo{photos.length === 1 ? '' : 's'}</strong>
        </div>
      </div>

      <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
        <input
          className="input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Restaurant name (auto-detected or type)"
          aria-label="Restaurant name, optional — tap mic to speak it"
          style={{ flex: 1, margin: 0 }}
        />
        <button
          onClick={nameRecState === 'recording' ? stopSpeakName : speakName}
          disabled={nameRecState === 'working' || analyzing}
          aria-label={nameRecState === 'recording' ? 'Done speaking name' : 'Speak the restaurant name'}
          style={{
            minHeight: 64,
            minWidth: 64,
            borderRadius: 'var(--r-md)',
            border: `2px solid ${nameRecState === 'recording' ? 'var(--success)' : 'var(--border)'}`,
            background: nameRecState === 'recording' ? 'var(--success)' : 'var(--surface-high)',
            color: 'var(--text-primary)',
            fontSize: 22,
            cursor: 'pointer',
          }}
        >
          {nameRecState === 'recording' ? 'Stop' : nameRecState === 'working' ? '…' : 'Mic'}
        </button>
      </div>

      <button
        onClick={() => setAutoMode((v) => !v)}
        aria-pressed={autoMode}
        aria-label={`Auto capture ${autoMode ? 'on' : 'off'}. Tap to turn ${autoMode ? 'off' : 'on'}.`}
        className="btn"
        style={{
          minHeight: 56,
          border: `2px solid ${autoMode ? 'var(--accent)' : 'var(--border)'}`,
          background: autoMode ? 'var(--surface-high)' : 'var(--surface)',
          color: autoMode ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        {autoMode ? '⦿ Auto-capture: ON' : '○ Auto-capture: OFF'}
      </button>

      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '3 / 4',
          background: '#000',
          borderRadius: 'var(--r-lg)',
          overflow: 'hidden',
          border: `3px solid ${
            !autoMode ? 'var(--border)' :
            captureStateDraw === 'steadying' ? 'var(--success)' :
            captureStateDraw === 'moving' ? '#ffc800' :
            (captureStateDraw === 'dark' || captureStateDraw === 'content') ? 'var(--danger)' :
            'var(--border)'
          }`,
          transition: 'border-color 0.2s',
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          aria-hidden="true"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {autoMode && !analyzing && (
          <canvas
            ref={overlayRef}
            width={300}
            height={400}
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
            }}
          />
        )}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'white',
            opacity: flash ? 0.88 : 0,
            transition: flash ? 'none' : 'opacity 0.32s ease-out',
            pointerEvents: 'none',
          }}
        />
        {analyzing && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--overlay)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-primary)',
              fontSize: 20,
            }}
          >
            Reading the menu…
          </div>
        )}
      </div>

      {camError ? (
        <p role="alert" className="body" style={{ color: 'var(--danger)' }}>{camError}</p>
      ) : null}
      <p role="status" className="body" aria-live="polite" style={{ textAlign: 'center', minHeight: 28 }}>
        {status}
      </p>

      <div className="col">
        <PrimaryButton
          label={
            !cameraReady && !camError ? 'Starting camera…' :
            autoMode ? 'Override — take photo now' : 'Capture photo'
          }
          hint={autoMode ? 'Take the photo immediately without waiting for auto-capture' : 'Takes a photo of the menu'}
          onClick={manualCapture}
          disabled={analyzing || !!camError || !cameraReady}
          style={{ minHeight: 80 }}
        />
        <div className="row">
          <SecondaryButton label="Upload from Library" onClick={() => fileRef.current?.click()} disabled={analyzing} />
          <PrimaryButton label={`Done — Analyze (${photos.length})`} onClick={analyze} disabled={analyzing || photos.length === 0} />
        </div>

        {/* Voice commands: only shown once at least one photo is captured */}
        {photos.length > 0 && !analyzing && (
          <PrimaryButton
            label={
              voicePhase === 'recording'    ? 'Done speaking' :
              voicePhase === 'transcribing' ? 'Hearing you…'  :
              voicePhase === 'announcing'   ? 'Please wait…'  :
                                              'Say "analyze", "another", or "cancel"'
            }
            hint="Voice command: analyze, another photo, or cancel"
            onClick={voicePhase === 'recording' ? voiceDone : voiceListen}
            disabled={voicePhase === 'transcribing' || voicePhase === 'announcing'}
            style={{
              minHeight: 70,
              background: voicePhase === 'recording' ? 'var(--success)' : 'var(--surface-high)',
              color: 'var(--text-primary)',
              border: '2px solid var(--border)',
              fontSize: 16,
            }}
          />
        )}

        <SecondaryButton label="Cancel" onClick={goBack} disabled={analyzing} />
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickFiles} />
    </Screen>
  );
}
