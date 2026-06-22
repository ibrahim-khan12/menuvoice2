// Microphone recording via MediaRecorder.
// Most voice flows auto-stop via silence detection (see lib/vad.ts).
// Email capture on the login screen still uses manual tap-to-stop.

let mediaRecorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let stream: MediaStream | null = null;

export async function startRecording(): Promise<void> {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];

  // Pick a mime type the browser supports (Safari -> mp4, Chrome -> webm).
  const candidates = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  let mimeType = '';
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) {
      mimeType = c;
      break;
    }
  }

  mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.start();
}

/** Stop and return the recorded audio Blob (or null). */
export function stopRecording(): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve(null);
    const mr = mediaRecorder;
    mr.onstop = () => {
      const type = mr.mimeType || 'audio/webm';
      const blob = chunks.length ? new Blob(chunks, { type }) : null;
      chunks = [];
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      mediaRecorder = null;
      resolve(blob);
    };
    mr.stop();
  });
}

export function getActiveStream(): MediaStream | null {
  return stream;
}

export function isRecording(): boolean {
  return mediaRecorder !== null && mediaRecorder.state === 'recording';
}

export async function requestMicPermission(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}
