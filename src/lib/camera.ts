// Camera access via getUserMedia + frame capture to a base64 JPEG.
//
// LIVE / AUTO-CAPTURE NOTE: real document-scanner auto-shutter (edge detection,
// auto-trigger when a flat page is held steady) is possible on web with an
// edge-detection lib (OpenCV.js / jscanify) running per video frame, but it is
// finicky in dim restaurant lighting. For the prototype we use a manual shutter
// with spoken feedback. captureFrame() is the seam where auto-capture would call
// in once a "steady flat page" heuristic fires.

/**
 * Try to enable the device torch/flashlight on the active camera track.
 * Returns true if it worked. Silently no-ops on iOS Safari (no torch API).
 */
export async function enableTorch(stream: MediaStream): Promise<boolean> {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return false;
    const caps = (track.getCapabilities as any)?.() as any;
    if (!caps?.torch) return false;
    await track.applyConstraints({ advanced: [{ torch: true } as any] });
    return true;
  } catch {
    return false;
  }
}

/** Turn the torch off. No-op if not supported or not currently enabled. */
export function disableTorch(stream: MediaStream): void {
  try {
    const track = stream.getVideoTracks()[0];
    if (track) track.applyConstraints({ advanced: [{ torch: false } as any] }).catch(() => {});
  } catch {}
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', 'true');

  // Wait until the video actually has dimensions before reporting ready, so
  // callers don't start coaching/auto-capture against a 0x0 black frame.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (video.readyState >= 2 && video.videoWidth > 0) return done();
    video.onloadedmetadata = () => { video.play().catch(() => {}); };
    video.oncanplay = () => done();
    // Safety net: don't hang forever if events never fire.
    setTimeout(done, 4000);
  });

  // Belt-and-suspenders: autoPlay attribute usually covers this, but retry in
  // case the first play() was blocked.
  await video.play().catch(() => {});
  return stream;
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
  value: number;
  native: boolean;
}

export function getZoomRange(stream: MediaStream | null): ZoomRange {
  const fallback = { min: 1, max: 3, step: 0.25, value: 1, native: false };
  try {
    const track = stream?.getVideoTracks()[0];
    if (!track) return fallback;
    const caps = (track.getCapabilities as any)?.() as any;
    const settings = (track.getSettings as any)?.() as any;
    if (!caps?.zoom) return fallback;
    return {
      min: Number(caps.zoom.min ?? 1),
      max: Number(caps.zoom.max ?? 3),
      step: Number(caps.zoom.step ?? 0.25),
      value: Number(settings?.zoom ?? caps.zoom.min ?? 1),
      native: true,
    };
  } catch {
    return fallback;
  }
}

export async function setZoom(stream: MediaStream | null, value: number): Promise<boolean> {
  try {
    const track = stream?.getVideoTracks()[0];
    if (!track) return false;
    const caps = (track.getCapabilities as any)?.() as any;
    if (!caps?.zoom) return false;
    await track.applyConstraints({ advanced: [{ zoom: value } as any] });
    return true;
  } catch {
    return false;
  }
}

/** Grab the current video frame as a base64 JPEG (no data: prefix). */
export function captureFrame(video: HTMLVideoElement, quality = 0.6, fallbackZoom = 1): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const zoom = Math.max(1, fallbackZoom);
  if (zoom === 1) {
    ctx.drawImage(video, 0, 0, w, h);
  } else {
    const sw = w / zoom;
    const sh = h / zoom;
    const sx = (w - sw) / 2;
    const sy = (h - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  }
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.split(',')[1] ?? null;
}

/** Read a user-selected image File as a base64 JPEG (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Resize and re-encode any image File (JPEG, PNG, WebP, HEIC via iOS, etc.)
 * into a base64 JPEG string (no data: prefix) with a capped long dimension.
 * This normalises format, shrinks large phone photos, and prevents OpenAI
 * rejecting payloads that are too large.
 */
export function compressImage(file: File, maxDim = 1500, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 60 * 1024 * 1024) {
      reject(new Error(`"${file.name}" is too large (${Math.round(file.size / 1024 / 1024)} MB max 60 MB).`));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { naturalWidth: w, naturalHeight: h } = img;
      const scale = Math.min(1, maxDim / Math.max(w, h, 1));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0, cw, ch);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve(dataUrl.split(',')[1] ?? '');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read "${file.name}". Use JPEG or PNG.`));
    };
    img.src = url;
  });
}
