// Menu capture (web). Live camera preview with AUTO-SHUTTER + live coaching,
// plus a manual shutter, multi-photo library upload, then AI analysis.
//
// This screen never speaks — all coaching and status lands in the two
// aria-live regions below the preview, so the user's screen reader is the
// only voice and nothing talks over it. Earcons (ticks, shutter) remain as
// non-speech cues. App TTS is reserved for Conversation Mode.

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps, Route } from '../nav';
import { ParsedMenu } from '../types';
import { speak, stopSpeaking } from '../lib/speech';
import { usePause } from '../state/PauseContext';
import {
  startCamera,
  stopCamera,
  captureFrame,
  compressImage,
  enableTorch,
  disableTorch,
  getZoomRange,
  nextZoomValue,
  setZoom as setCameraZoom,
  type ZoomRange,
} from '../lib/camera';
import { parseMenuFromImages, hasApiKey } from '../lib/openai';
import { friendlyError, SERVICE_UNAVAILABLE_MSG } from '../lib/errors';
import { saveRestaurant } from '../lib/storage';
import { MenuScanner } from '../lib/scanner';
import { assessPhotoQuality, type PhotoQualityIssue } from '../lib/photoQuality';
import { earconTick, earconCapture } from '../lib/earcon';
import { PacedAnnouncer } from '../lib/announcer';
import { track, isImageLoggingOn } from '../lib/telemetry';
import { apiUrl } from '../lib/apiUrl';

// Where the camera starts when it has a real zoom range to work with.
//
// This was 0.5x, chosen to fit more of the page in frame without backing away.
// On a real table that backfired: people hold the phone well above the menu,
// and at 0.5x the text lands too small for the model to read. 0.8x still takes
// in a whole page from a comfortable height while keeping the text large
// enough. Zoom out is one tap away for anything bigger.
const DEFAULT_ZOOM = 0.8;

const ANALYSIS_PHRASES = [
  'Still reading your menu, just a moment.',
  'Almost there, hang tight.',
  'Still working on it, one more moment.',
];

interface CapturedPhoto {
  id: number;
  imageBase64: string;
  issues: PhotoQualityIssue[];
  checkingQuality: boolean;
}

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
  const { paused, registerStopListening } = usePause();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoRef = useRef<MenuScanner | null>(null);
  const analyzingRef = useRef(false);
  const prevSteadyRef = useRef(0);
  const reassureIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reassureCountRef = useRef(0);
  const nextPhotoIdRef = useRef(1);
  const photosRef = useRef<CapturedPhoto[]>([]);
  const zoomRef = useRef(1);
  const zoomRangeRef = useRef<ZoomRange>({ min: 1, max: 3, step: 0.25, value: 1, native: false });
  const lastSpokenGuidanceRef = useRef({ text: '', at: 0 });

  const [photos, setPhotosState] = useState<CapturedPhoto[]>([]);
  const [confirmAnalyzeWithIssues, setConfirmAnalyzeWithIssues] = useState(false);
  // ONE live region, paced. Two regions updating independently meant a screen
  // reader was constantly cut off mid-sentence — including by the message that
  // matters most, "photo taken, turn the page", which lands exactly when
  // coaching resumes. setStatus/setCoachStatus keep their old call sites but
  // now feed a queue that lets each message finish.
  //   status      = something happened, must not be missed  -> urgent
  //   coachStatus = live guidance, superseded freely        -> normal
  const [announcement, setAnnouncement] = useState('');
  const announcerRef = useRef<PacedAnnouncer | null>(null);
  if (!announcerRef.current) announcerRef.current = new PacedAnnouncer(setAnnouncement);
  const setStatus = (text: string) => announcerRef.current?.announce(text, 'urgent');
  const setCoachStatus = (text: string) => announcerRef.current?.announce(text, 'normal');
  const [camError, setCamError] = useState('');

  const sayGuidance = (message: string) => {
    if (paused || !message) return;
    const last = lastSpokenGuidanceRef.current;
    const now = Date.now();
    if (last.text === message || now - last.at < 1800) return;
    lastSpokenGuidanceRef.current = { text: message, at: now };
    void speak(message);
  };
  const [cameraReady, setCameraReady] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [previewAspect, setPreviewAspect] = useState('3 / 4');
  const [zoomRange, setZoomRange] = useState<ZoomRange>({ min: 1, max: 3, step: 0.25, value: 1, native: false });
  const [zoom, setZoom] = useState(1);

  const setPhotos = (updater: (prev: CapturedPhoto[]) => CapturedPhoto[]) => {
    const next = updater(photosRef.current);
    photosRef.current = next;
    setPhotosState(next);
  };

  // Promote the next queued message once the current one has had time to be
  // read. 250ms is well under the shortest hold, so nothing waits on the timer.
  useEffect(() => {
    const id = setInterval(() => announcerRef.current?.pump(), 250);
    return () => {
      clearInterval(id);
      announcerRef.current?.reset();
    };
  }, []);

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
          // Start at DEFAULT_ZOOM when the device's native zoom range supports
          // it, otherwise clamp to whatever the hardware allows. Software/CSS
          // zoom (non-native) can never go below 1 — there is no way to see
          // more than the sensor's native capture.
          const initialZoom = range.native ? Math.min(range.max, Math.max(range.min, DEFAULT_ZOOM)) : 1;
          if (range.native) await setCameraZoom(s, initialZoom);
          const initialRange = { ...range, value: initialZoom };
          zoomRangeRef.current = initialRange;
          zoomRef.current = initialZoom;
          setZoomRange(initialRange);
          setZoom(initialZoom);
          setCameraReady(true);
          enableTorch(s);
          sayGuidance('Camera ready. Point at the menu. I will take the photo.');
          track('capture', 'camera_start', { outcome: 'success' });
        }
      } catch {
        const msg =
          'No camera. On iPhone, allow camera access for this site. You can also use Upload photos.';
        setCamError(msg);
        track('capture', 'camera_start', { outcome: 'failure', metadata: { error: msg } });
        track('error', 'camera', { metadata: { error: msg } });
      }
    })();
    return () => {
      cancelled = true;
      autoRef.current?.stop();
      if (streamRef.current) disableTorch(streamRef.current);
      stopCamera(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  // Turning the phone swaps the camera track's dimensions, and a <video> fires
  // 'resize' when that happens (loadedmetadata does not fire a second time).
  // Without this the preview box keeps the old shape and letterboxes the frame,
  // so the picture a sighted helper sees stops matching what is being analysed.
  // The scanner re-shapes its own analysis buffer independently, in analyze().
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onResize = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      setPreviewAspect(`${video.videoWidth} / ${video.videoHeight}`);
      track('capture', 'orientation_change', {
        metadata: {
          width: video.videoWidth,
          height: video.videoHeight,
          orientation: video.videoWidth >= video.videoHeight ? 'landscape' : 'portrait',
        },
      });
    };
    video.addEventListener('resize', onResize);
    return () => video.removeEventListener('resize', onResize);
  }, []);

  // Pause Voice stops the auto-capture scanner here too. pause() calls this
  // handler synchronously, so the scanner stops the moment the button is
  // pressed — before any React re-render. The paused-gated effects below then
  // keep it stopped until Resume Voice.
  useEffect(() => {
    return registerStopListening(() => {
      autoRef.current?.stop();
      stopSpeaking();
      if (reassureIdRef.current) {
        clearInterval(reassureIdRef.current);
        reassureIdRef.current = null;
      }
    });
  }, [registerStopListening]);

  // While paused, make sure nothing restarts and surface the paused state.
  useEffect(() => {
    if (!paused) return;
    autoRef.current?.stop();
    stopSpeaking();
    setStatus('Paused. Tap Resume Voice to continue capture guidance.');
    setCoachStatus('');
  }, [paused]);

  // Periodic reassurance while analysis runs.
  useEffect(() => {
    if (!analyzing || paused) {
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
    }, 5000);
    reassureIdRef.current = id;
    return () => clearInterval(id);
  }, [analyzing, paused]);

  // Run / stop the auto-capture controller.
  useEffect(() => {
    const active = autoMode && cameraReady && !analyzing && !camError && !paused;
    if (!active) {
      autoRef.current?.stop();
      return;
    }
    if (!autoRef.current) autoRef.current = new MenuScanner();

    if (videoRef.current) {
      autoRef.current.start(videoRef.current, {
        onCoach: (msg) => {
          setCoachStatus(msg);
          sayGuidance(msg);
        },
        onCapture: () => {
          const range = zoomRangeRef.current;
          addPhoto(captureFrame(videoRef.current!, 0.6, range.native ? 1 : zoomRef.current), true);
          autoRef.current?.acknowledgeCapture();
        },
        onAutoZoom: (direction) => {
          const range = zoomRangeRef.current;
          const current = zoomRef.current;
          const next = nextZoomValue(range, current, direction);
          if (next === current) return false;

          zoomRef.current = next;
          zoomRangeRef.current = { ...range, value: next };
          setZoomRange(zoomRangeRef.current);
          setZoom(next);
          if (range.native) {
            void setCameraZoom(streamRef.current, next).then((applied) => {
              if (!applied) {
                zoomRef.current = current;
                zoomRangeRef.current = {
                  ...range,
                  value: current,
                  min: direction < 0 ? current : range.min,
                  max: direction > 0 ? current : range.max,
                };
                setZoomRange(zoomRangeRef.current);
                setZoom(current);
              }
            });
          } else {
            autoRef.current?.setAnalysisZoom(next);
          }
          track('capture', 'zoom_adjust', {
            metadata: { mode: 'auto', direction: direction > 0 ? 'in' : 'out', zoom: next, native: range.native },
          });
          return true;
        },
        onStruggle: () => {
          // Auto capture deliberately stays ON. This fires only when there has
          // been nothing readable in frame for a while — camera covered, or
          // pointed away from the menu — and in that situation switching to
          // manual just hands the problem to the person least able to see it.
          // The scanner keeps running and will fire the moment a menu appears;
          // this only adds the manual button as a second option.
          track('capture', 'scanner_struggle', { metadata: { fallback: 'manual_offered' } });
          setCoachStatus(
            'I still cannot see a menu. Check nothing is covering the camera. ' +
            'I am still looking and will take the photo when I see it. You can also tap Take photo.'
          );
          sayGuidance('I cannot see a menu yet. Point the camera at the page. I am still watching.');
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
      autoRef.current.setAnalysisZoom(zoomRangeRef.current.native ? 1 : zoomRef.current);
    }

    return () => {
      autoRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode, cameraReady, analyzing, camError, paused]);

  const finishPhotoQuality = (id: number, quality: { ok: boolean; issues: PhotoQualityIssue[] }) => {
    const index = photosRef.current.findIndex((photo) => photo.id === id);
    if (index === -1) return;
    setPhotos((prev) =>
      prev.map((photo) =>
        photo.id === id
          ? { ...photo, issues: quality.issues, checkingQuality: false }
          : photo
      )
    );
    track('capture', 'photo_quality', {
      metadata: {
        photo_number: index + 1,
        quality_ok: quality.ok,
        issues: quality.issues.map((i) => i.code),
      },
    });
    if (!quality.ok) {
      const msg = `Photo ${index + 1}. ${quality.issues.map((i) => i.message).join(' ')} Tap Retake last photo to do it again, or Read menu to go on.`;
      setStatus(msg);
      sayGuidance(msg);
    }
  };

  // Runs after every capture (manual or auto). Add the photo immediately, then
  // attach the quality verdict when decoding finishes so the capture flow never
  // appears to stall.
  const addPhoto = (b64: string | null, viaAuto: boolean) => {
    if (!b64) return;
    if (viaAuto) earconCapture();
    setConfirmAnalyzeWithIssues(false);
    const id = nextPhotoIdRef.current++;
    setPhotos((prev) => {
      const next = [...prev, { id, imageBase64: b64, issues: [], checkingQuality: true }];
      const count = next.length;
      // "Turn to the next page" is the whole point of this message: without it
      // people do not know the app is ready for another, and stand there
      // waiting. Urgent, so it is never cut off by resuming coaching.
      const msg = `Photo ${count} taken. Turn to the next page, or tap Read menu.`;
      setStatus(msg);
      sayGuidance(msg);
      track('capture', 'photo_added', {
        metadata: {
          mode: viaAuto ? 'auto' : 'manual',
          photo_count: count,
        },
      });
      return next;
    });
    assessPhotoQuality(b64)
      .then((quality) => finishPhotoQuality(id, quality))
      .catch(() => finishPhotoQuality(id, { ok: true, issues: [] }));
  };

  const manualCapture = () => {
    if (analyzing || !videoRef.current) return;
    addPhoto(captureFrame(videoRef.current, 0.6, zoomRangeRef.current.native ? 1 : zoomRef.current), false);
  };

  /** Remove the most recently captured/uploaded photo so the user can redo it. */
  const retakeLastPhoto = () => {
    if (photos.length === 0 || analyzing) return;
    setConfirmAnalyzeWithIssues(false);
    setPhotos((prev) => prev.slice(0, -1));
    const msg = 'Removed the last photo. Take it again when ready.';
    setStatus(msg);
    track('capture', 'photo_removed', { metadata: { photo_count: photos.length - 1 } });
  };

  const changeZoom = async (direction: 1 | -1) => {
    const range = zoomRangeRef.current;
    const current = zoomRef.current;
    const next = nextZoomValue(range, current, direction);
    if (next === current) return;
    const native = await setCameraZoom(streamRef.current, next);
    if (range.native && !native) {
      setStatus('This camera could not change zoom.');
      return;
    }
    const nextRange = { ...range, value: next, native: native || range.native };
    zoomRangeRef.current = nextRange;
    zoomRef.current = next;
    setZoomRange(nextRange);
    setZoom(next);
    autoRef.current?.setAnalysisZoom(nextRange.native ? 1 : next);
    const msg = `Zoom ${next.toFixed(next % 1 === 0 ? 0 : 1)}x.`;
    setStatus(msg);
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    e.target.value = '';

    const msg = `Processing ${files.length} photo${files.length > 1 ? 's' : ''}...`;
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
      setConfirmAnalyzeWithIssues(false);
      const entries = added.map((imageBase64) => ({
        id: nextPhotoIdRef.current++,
        imageBase64,
        issues: [],
        checkingQuality: true,
      }));
      setPhotos((prev) => {
        const next = [...prev, ...entries];
        let m = `Added ${added.length} photo${added.length > 1 ? 's' : ''}. ${next.length} total.`;
        if (failedNames.length) m += ` ${failedNames.length} could not be read — use JPEG or PNG.`;
        m += ' Checking photo quality.';
        setStatus(m);
        return next;
      });
      const qualityResults = await Promise.all(
        entries.map((photo) =>
          assessPhotoQuality(photo.imageBase64)
            .then((quality) => ({ id: photo.id, quality }))
            .catch(() => ({ id: photo.id, quality: { ok: true, issues: [] } }))
        )
      );
      const resultById = new Map(qualityResults.map((result) => [result.id, result.quality]));
      const flaggedNumbers = photosRef.current
        .map((photo, index) => {
          const quality = resultById.get(photo.id);
          return quality && !quality.ok ? index + 1 : null;
        })
        .filter((n): n is number => n !== null);
      setPhotos((prev) =>
        prev.map((photo) => {
          const quality = resultById.get(photo.id);
          return quality
            ? { ...photo, issues: quality.issues, checkingQuality: false }
            : photo;
        })
      );
      for (const result of qualityResults) {
        track('capture', 'photo_quality', {
          metadata: {
            quality_ok: result.quality.ok,
            issues: result.quality.issues.map((i) => i.code),
          },
        });
      }
      if (flaggedNumbers.length) {
        // Name the control: a vague suggestion to retake is not something a
        // blind user can act on, with no way to guess which button does it.
        const m = flaggedNumbers.length === 1
          ? `Photo ${flaggedNumbers[0]} may be hard to read. Tap Retake last photo to do it again.`
          : `Photos ${flaggedNumbers.join(', ')} may be hard to read. Tap Retake last photo to redo the most recent one.`;
        setStatus(m);
      }
    } else {
      const errMsg =
        failedNames.length === 1
          ? `Could not read "${failedNames[0]}". Use a JPEG or PNG photo.`
          : `Could not read ${failedNames.length} files. Use JPEG or PNG photos.`;
      setStatus(errMsg);
    }
  };

  const analyze = async () => {
    if (photos.length === 0) {
      setStatus('Capture at least one photo of the menu first.');
      return;
    }
    if (!hasApiKey()) {
      setStatus(SERVICE_UNAVAILABLE_MSG);
      return;
    }
    const pendingCount = photos.filter((photo) => photo.checkingQuality).length;
    if (pendingCount > 0) {
      const m = 'Still checking photo quality. Try Read menu again in a moment.';
      setStatus(m);
      return;
    }
    const flaggedCount = photos.filter((photo) => photo.issues.length > 0).length;
    if (flaggedCount > 0 && !confirmAnalyzeWithIssues) {
      setConfirmAnalyzeWithIssues(true);
      setStatus(`Heads up. ${flaggedCount} of your ${photos.length} photo${photos.length === 1 ? '' : 's'} may have quality problems, like blur or tilt. Tap Read menu again to continue anyway, or tap Retake last photo to redo the most recent one.`);
      return;
    }
    analyzingRef.current = true;
    setAnalyzing(true);
    autoRef.current?.stop();
    setStatus('Reading the menu. This takes a few seconds.');

    track('capture', 'analyze_start', { metadata: { photo_count: photos.length } });
    const t0 = Date.now();
    const imageBase64 = photos.map((photo) => photo.imageBase64);

    // Upload images to Blob only when the owner has the toggle on.
    let blobUrls: string[] | undefined;
    if (isImageLoggingOn()) {
      try {
        const uploads = await Promise.allSettled(
          imageBase64.map(async (b64, i) => {
            const r = await fetch(apiUrl('/api/upload-image'), {
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
      let menu = await parseMenuFromImages(imageBase64);
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
      // A camera scan is a first-party, location-specific read by definition: the
      // user is standing at the restaurant photographing its own menu.
      const provenance = {
        sourceType: 'photo' as const,
        official: true,
        locationScope: 'location_specific' as const,
        checkedAt: new Date().toISOString(),
        completeness: (menu.incomplete ? 'partial' : 'complete') as 'partial' | 'complete',
        sourceLabel: 'the photo of the physical menu',
        warnings: menu.incompleteReason ? [menu.incompleteReason] : undefined,
      };
      await saveRestaurant(restaurantName, menu, { provenance }).catch(() => {});
      stopCamera(streamRef.current);
      navigate({ name: 'conversation', menu, restaurantName, source: 'photo', provenance });
    } catch (e: any) {
      track('capture', 'ocr_result', {
        outcome: 'failure',
        durationMs: Date.now() - t0,
        metadata: { error: String(e?.message) },
      });
      const errMsg = friendlyError(
        e,
        'I could not read the menu. Tap Retake last photo, add more light, and try again.',
      );
      setStatus(errMsg);
      setAnalyzing(false);
      analyzingRef.current = false;
    }
  };

  return (
    <Screen label="Hold the phone flat over the menu. I will guide you.">
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

      {/* Read menu sits at the TOP, directly under the heading.
          It is the step that actually starts the reading, and buried at the
          bottom of a long control stack a VoiceOver user had to swipe past the
          preview, the zoom pair, the shutter and the upload button to reach it.
          Its label carries the photo count, so it is also the running progress
          report. */}
      {photos.length > 0 && (
        <PrimaryButton
          label={analyzing ? 'Reading...' : `Read menu (${photos.length})`}
          hint="Read the menu from the photos you have taken"
          onClick={analyze}
          disabled={analyzing}
          style={{ minHeight: 80 }}
        />
      )}

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
        <span aria-hidden="true">{autoMode ? 'Auto capture: ON' : 'Auto capture: OFF'}</span>
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
            Reading the menu...
          </div>
        )}
      </div>

      {camError ? (
        <p role="alert" className="body" style={{ color: 'var(--danger)' }}>{camError}</p>
      ) : null}
      {/* One paced live region for coaching, photo confirmations and analysis.
          Nothing on this screen speaks, so the screen reader is the only voice
          — and a single region is the only way to stop it interrupting itself. */}
      <p role="status" className="body" aria-live="polite" style={{ textAlign: 'center', minHeight: 48 }}>
        {announcement}
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
            !cameraReady && !camError ? 'Starting camera...' : 'Take photo'
          }
          hint={autoMode ? 'Take a photo now' : 'Take a photo of the menu'}
          onClick={manualCapture}
          disabled={analyzing || !!camError || !cameraReady}
          style={{ minHeight: 80 }}
        />

        {photos.length > 0 && (
          <SecondaryButton
            label="Retake last photo"
            hint={
              photos[photos.length - 1]?.issues.length
                ? 'The last photo may have quality issues. Remove it and take it again.'
                : 'Remove the last photo and take it again'
            }
            onClick={retakeLastPhoto}
            disabled={analyzing}
          />
        )}

        <div className="row">
          <button
            className="btn btn-secondary upload-photos-button"
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={analyzing}
            aria-label="Upload photos from your device"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="2" />
              <circle cx="8.5" cy="9" r="1.5" fill="currentColor" />
              <path d="m5.5 17 4.2-4.2a1.5 1.5 0 0 1 2.1 0l2 2 1.2-1.2a1.5 1.5 0 0 1 2.1 0l2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Upload photos</span>
          </button>
        </div>

        <SecondaryButton label="Cancel" onClick={goBack} disabled={analyzing} />
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickFiles} />
    </Screen>
  );
}
