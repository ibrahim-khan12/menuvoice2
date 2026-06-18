// Menu capture (web). Live camera preview with AUTO-SHUTTER + audio coaching,
// plus a manual shutter, multi-photo library upload, then AI analysis.
//
// All capture coaching goes through browser speechSynthesis (coach()) on a
// single channel — no OpenAI TTS during capture so there's no double-talk.
// Analysis wait: periodic speak() reassurance while parseMenuFromImages runs.

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps, Route } from '../nav';
import { ParsedMenu } from '../types';
import { speak, coach, stopCoach, isAppVoiceOn } from '../lib/speech';
import {
  startCamera,
  stopCamera,
  captureFrame,
  compressImage,
  enableTorch,
  disableTorch,
  getZoomRange,
  setZoom as setCameraZoom,
  type ZoomRange,
} from '../lib/camera';
import { parseMenuFromImages, hasApiKey } from '../lib/openai';
import { saveRestaurant } from '../lib/storage';
import { MenuScanner } from '../lib/scanner';
import { earconTick, earconCapture } from '../lib/earcon';
import { track, isImageLoggingOn } from '../lib/telemetry';

const ANALYSIS_PHRASES = [
  'Still reading your menu, just a moment.',
  'Almost there, hang tight.',
  'Still working on it, one more moment.',
];

// When supplementing an existing (incomplete) menu, fold the new parse into it:
// items join their matching category by name; new categories are appended.
function mergeMenus(base: ParsedMenu, extra: ParsedMenu): ParsedMenu {
  const categories = base.categories.map((c) => ({ ...c, items: [...c.items] }));
  for (const cat of extra.categories) {
    const existing = categories.find(
      (c) => c.name.trim().toLowerCase() === cat.name.trim().toLowerCase()
    );
    if (!existing) {
      categories.push(cat);
      continue;
    }
    for (const item of cat.items) {
      const dup = existing.items.some(
        (i) => i.name.trim().toLowerCase() === item.name.trim().toLowerCase()
      );
      if (!dup) existing.items.push(item);
    }
  }
  return {
    ...base,
    categories,
    restaurantName: base.restaurantName || extra.restaurantName,
    pageCount: (base.pageCount ?? 0) + (extra.pageCount ?? 0),
    // Stay honest: only clear the flag if the new photos look complete too.
    incomplete: extra.incomplete === true,
  };
}

export default function CaptureScreen({
  navigate,
  goBack,
  route,
}: ScreenProps & { route: Extract<Route, { name: 'capture' }> }) {
  const appendTo = route.appendTo;
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoRef = useRef<MenuScanner | null>(null);
  const analyzingRef = useRef(false);
  const prevSteadyRef = useRef(0);
  const reassureIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reassureCountRef = useRef(0);

  const [photos, setPhotos] = useState<string[]>([]);
  const [status, setStatus] = useState('Starting camera…');
  const [coachStatus, setCoachStatus] = useState('');
  const [camError, setCamError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [previewAspect, setPreviewAspect] = useState('3 / 4');
  const [zoomRange, setZoomRange] = useState<ZoomRange>({ min: 1, max: 3, step: 0.25, value: 1, native: false });
  const [zoom, setZoom] = useState(1);

  // Start / stop camera.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (videoRef.current) {
          const s = await startCamera(videoRef.current);
          if (cancelled) { stopCamera(s); return; }
          streamRef.current = s;
          const video = videoRef.current;
          if (video.videoWidth && video.videoHeight) {
            setPreviewAspect(`${video.videoWidth} / ${video.videoHeight}`);
          }
          const range = getZoomRange(s);
          const initialZoom = range.native ? range.min : 1;
          if (range.native) await setCameraZoom(s, initialZoom);
          setZoomRange({ ...range, value: initialZoom });
          setZoom(initialZoom);
          setCameraReady(true);
          enableTorch(s);
          track('capture', 'camera_start', { outcome: 'success' });
        }
      } catch {
        const msg =
          'Camera unavailable. On iPhone, open this site over HTTPS and allow camera access. You can still upload photos using the Upload from Library button.';
        setCamError(msg);
        speak(msg);
        track('capture', 'camera_start', { outcome: 'failure', metadata: { error: msg } });
        track('error', 'camera', { metadata: { error: msg } });
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

  // Periodic reassurance while analysis runs.
  useEffect(() => {
    if (!analyzing) {
      if (reassureIdRef.current) {
        clearInterval(reassureIdRef.current);
        reassureIdRef.current = null;
      }
      reassureCountRef.current = 0;
      return;
    }
    reassureCountRef.current = 0;
    const id = setInterval(() => {
      const msg = ANALYSIS_PHRASES[reassureCountRef.current % ANALYSIS_PHRASES.length];
      reassureCountRef.current++;
      setStatus(msg);
      speak(msg);
    }, 5000);
    reassureIdRef.current = id;
    return () => clearInterval(id);
  }, [analyzing]);

  // Run / stop the auto-capture controller.
  useEffect(() => {
    const active = autoMode && cameraReady && !analyzing && !camError;
    if (!active) {
      autoRef.current?.stop();
      stopCoach();
      return;
    }
    if (!autoRef.current) autoRef.current = new MenuScanner();

    let cancelled = false;
    const intro =
      'Auto capture is on. Hold your phone flat, about a foot above the menu. ' +
      'I will guide you and take the photo automatically. If I take too long, ' +
      'find the Take photo button below the camera.';
    setCoachStatus('Auto capture on. Hold your phone flat over the menu.');

    (async () => {
      await speak(intro);
      if (cancelled || !videoRef.current) return;
      autoRef.current!.start(videoRef.current, {
        onCoach: (msg) => {
          setCoachStatus(msg);
          coach(msg);
        },
        onCapture: () => {
          addPhoto(captureFrame(videoRef.current!, 0.6, zoomRange.native ? 1 : zoom), true);
          autoRef.current?.acknowledgeCapture();
        },
        onStruggle: () => {
          setAutoMode(false);
          track('capture', 'scanner_struggle', { metadata: { fallback: 'manual' } });
          const msg = 'Auto capture is having trouble. Switching to manual. Find the Take photo button and tap it when you are ready.';
          setCoachStatus('Switched to manual. Tap "Take photo" to take the shot.');
          coach(msg);
        },
        onState: (state, detail) => {
          track('capture', 'guidance', { metadata: { state, ...(detail ? { detail } : {}) } });
        },
        onProgress: (state, steady, max) => {
          if (state === 'steadying' && steady > prevSteadyRef.current) {
            earconTick(steady, max);
          }
          prevSteadyRef.current = state === 'steadying' ? steady : 0;
        },
      });
    })();

    return () => {
      cancelled = true;
      autoRef.current?.stop();
      stopCoach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode, cameraReady, analyzing, camError, zoom, zoomRange.native]);

  const addPhoto = (b64: string | null, viaAuto: boolean) => {
    if (!b64) return;
    if (viaAuto) earconCapture();
    setPhotos((prev) => {
      const next = [...prev, b64];
      const msg = viaAuto
        ? `Got it, photo ${next.length}. Line up the next page, or tap Analyze to read the menu.`
        : `Photo ${next.length} captured. Take another, or tap Analyze.`;
      setStatus(msg);
      coach(msg);
      track('capture', 'photo_added', { metadata: { mode: viaAuto ? 'auto' : 'manual', photo_count: next.length } });
      return next;
    });
  };

  const manualCapture = () => {
    if (analyzing || !videoRef.current) return;
    addPhoto(captureFrame(videoRef.current, 0.6, zoomRange.native ? 1 : zoom), false);
  };

  const changeZoom = async (direction: 1 | -1) => {
    const next = Math.min(zoomRange.max, Math.max(zoomRange.min, Number((zoom + direction * zoomRange.step).toFixed(2))));
    if (next === zoom) return;
    const native = await setCameraZoom(streamRef.current, next);
    setZoomRange((prev) => ({ ...prev, native: native || prev.native }));
    setZoom(next);
    const msg = `Zoom ${next.toFixed(next % 1 === 0 ? 0 : 1)}x.`;
    setStatus(msg);
    speak(msg);
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    e.target.value = '';

    const msg = `Processing ${files.length} photo${files.length > 1 ? 's' : ''}…`;
    setStatus(msg);

    const results = await Promise.allSettled(files.map((f) => compressImage(f)));
    const added: string[] = [];
    const failedNames: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') added.push(r.value);
      else failedNames.push(files[i].name);
    });

    track('capture', 'file_upload', {
      metadata: { count: files.length, added: added.length, failed: failedNames.length },
    });
    if (added.length) {
      setPhotos((prev) => {
        const next = [...prev, ...added];
        let m = `Added ${added.length} photo${added.length > 1 ? 's' : ''}. ${next.length} total.`;
        if (failedNames.length) m += ` ${failedNames.length} could not be read — use JPEG or PNG.`;
        setStatus(m);
        speak(m);
        return next;
      });
    } else {
      const errMsg =
        failedNames.length === 1
          ? `Could not read "${failedNames[0]}". Use a JPEG or PNG photo.`
          : `Could not read ${failedNames.length} files. Use JPEG or PNG photos.`;
      setStatus(errMsg);
      speak(errMsg);
    }
  };

  const analyze = async () => {
    if (photos.length === 0) {
      const m = 'Capture at least one photo of the menu first.';
      setStatus(m);
      speak(m);
      return;
    }
    if (!hasApiKey()) {
      const m = 'No API key configured. Set OPENAI_API_KEY in Vercel environment variables.';
      setStatus(m);
      speak(m);
      return;
    }
    analyzingRef.current = true;
    setAnalyzing(true);
    autoRef.current?.stop();
    stopCoach();
    const startMsg = 'Reading the menu. This takes a few seconds.';
    setStatus(startMsg);
    speak(startMsg);

    track('capture', 'analyze_start', { metadata: { photo_count: photos.length } });
    const t0 = Date.now();

    // Upload images to Blob only when the owner has the toggle on.
    let blobUrls: string[] | undefined;
    if (isImageLoggingOn()) {
      try {
        const uploads = await Promise.allSettled(
          photos.map(async (b64, i) => {
            const r = await fetch('/api/upload-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ imageBase64: b64, filename: `cap-${Date.now()}-${i}.jpg` }),
            });
            const d = await r.json() as { url?: string };
            return d.url ?? null;
          })
        );
        blobUrls = uploads
          .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
          .map((r) => r.value);
      } catch {}
    }

    try {
      let menu = await parseMenuFromImages(photos);
      menu = { ...menu, pageCount: photos.length };
      if (appendTo) menu = mergeMenus(appendTo.menu, menu);
      const itemCount = menu.categories.reduce((s, c) => s + c.items.length, 0);
      track('capture', 'ocr_result', {
        outcome: 'success',
        durationMs: Date.now() - t0,
        content: {
          restaurantName: menu.restaurantName,
          itemCount,
          ...(blobUrls ? { blobUrls } : {}),
        },
      });
      const restaurantName =
        appendTo?.restaurantName || menu.restaurantName?.trim() || 'This restaurant';
      await saveRestaurant(restaurantName, menu).catch(() => {});
      stopCamera(streamRef.current);
      navigate({ name: 'conversation', menu, restaurantName });
    } catch (e: any) {
      track('capture', 'ocr_result', {
        outcome: 'failure',
        durationMs: Date.now() - t0,
        metadata: { error: String(e?.message) },
      });
      const errMsg = e?.message ?? 'I could not read the menu. Try retaking the photos with more light.';
      setStatus(errMsg);
      speak(errMsg);
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

      <button
        onClick={() => setAutoMode((v) => !v)}
        aria-pressed={autoMode}
        aria-label={`Auto capture ${autoMode ? 'on' : 'off'}. Tap to turn ${autoMode ? 'off' : 'on'}.`}
        className="btn"
        style={{
          minHeight: 64,
          border: `2px solid ${autoMode ? 'var(--accent)' : 'var(--border)'}`,
          background: autoMode ? 'var(--surface-high)' : 'var(--surface)',
          color: autoMode ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        <span aria-hidden="true">{autoMode ? 'Auto-capture: ON' : 'Auto-capture: OFF'}</span>
      </button>

      <div
        className="capture-preview"
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: previewAspect,
          background: '#000',
          borderRadius: 'var(--r-lg)',
          overflow: 'hidden',
          border: '3px solid var(--border)',
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-hidden="true"
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            if (video.videoWidth && video.videoHeight) setPreviewAspect(`${video.videoWidth} / ${video.videoHeight}`);
          }}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform: zoomRange.native ? undefined : `scale(${zoom})`,
            transformOrigin: 'center center',
          }}
        />
        {analyzing && (
          <div
            aria-hidden="true"
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
      {/* Scanner coaching — silenced for VoiceOver when app voice is on (coach() already speaks it) */}
      <p role="status" className="body" aria-live={isAppVoiceOn() ? 'off' : 'polite'} style={{ textAlign: 'center', minHeight: 24 }}>
        {coachStatus}
      </p>
      {/* Analysis and photo-count feedback — always announced */}
      <p role="status" className="body" aria-live="polite" style={{ textAlign: 'center', minHeight: 24 }}>
        {status}
      </p>

      <div className="col capture-controls">
        <div className="row" role="group" aria-label="Camera zoom controls">
          <button
            className="btn btn-secondary"
            onClick={() => changeZoom(-1)}
            disabled={analyzing || !!camError || !cameraReady || zoom <= zoomRange.min}
            aria-label="Zoom out"
            style={{ minHeight: 64 }}
          >
            Zoom out
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => changeZoom(1)}
            disabled={analyzing || !!camError || !cameraReady || zoom >= zoomRange.max}
            aria-label="Zoom in"
            style={{ minHeight: 64 }}
          >
            Zoom in
          </button>
        </div>

        <PrimaryButton
          label={
            !cameraReady && !camError ? 'Starting camera…' : 'Take photo'
          }
          hint={autoMode ? 'Take the photo immediately without waiting for auto-capture' : 'Takes a photo of the menu'}
          onClick={manualCapture}
          disabled={analyzing || !!camError || !cameraReady}
          style={{ minHeight: 80 }}
        />

        <div className="row">
          <SecondaryButton
            label="Upload from Library"
            onClick={() => fileRef.current?.click()}
            disabled={analyzing}
          />
          {photos.length > 0 && (
            <PrimaryButton
              label={analyzing ? 'Reading…' : `Analyze (${photos.length})`}
              hint="Send the captured photos to AI for menu extraction"
              onClick={analyze}
              disabled={analyzing}
            />
          )}
        </div>

        <SecondaryButton label="Cancel" onClick={goBack} disabled={analyzing} />
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickFiles} />
    </Screen>
  );
}
