// Guided menu scanner — auto-shutter with real image analysis and actionable
// audio coaching for blind users. Replaces the old autocapture.ts.
//
// Per-frame metrics (160x120 grayscale, ~6fps, main thread — cheap at this size):
//   - luminance      mean brightness (too dark?)
//   - glareFrac      fraction of blown-out pixels (glare/reflection — a mean
//                    brightness check misses glare on an otherwise dim photo)
//   - sharpness      Laplacian variance (blur — from menuvoice 3)
//   - edgeDensity    how much text-like detail is in frame (is a menu there?)
//   - centroid       where the detail is (directional "move the menu left" hints)
//   - motion         inter-frame difference (steadiness)
//
// Coaching strategy:
//   - Each problem state has 2 escalating messages with a concrete fix; after
//     the second, silence until the state changes (no nagging).
//   - Steadying: spoken 3-2-1 countdown + rising earcon ticks, then capture.
//   - BEST-SHOT FALLBACK: if lighting + content are fine but perfect steadiness
//     never arrives, capture anyway after ~5s. The vision model tolerates a
//     slightly soft photo far better than a frustrated user tolerates waiting.
//   - After 20s without any capture, onStruggle fires -> manual mode.
//   - Every state change is reported via onState for telemetry.

export type ScanState =
  | 'searching'   // no menu-like content in frame
  | 'dark'
  | 'glare'
  | 'blur'
  | 'offcenter'
  | 'moving'
  | 'steadying'
  | 'disarmed';   // captured; waiting for movement to re-arm for the next page

export interface ScannerCallbacks {
  onCoach: (msg: string) => void;
  onCapture: () => void;
  onStruggle?: () => void;
  onState?: (state: ScanState, detail?: string) => void;
  onProgress?: (state: ScanState, steadyCount: number, steadyMax: number) => void;
}

const W = 160;
const H = 120;
const TICK_MS = 170;

// Thresholds (tuned for indoor restaurant light; metrics computed at 160x120)
const LUM_DARK = 40;          // mean luminance below this = too dark
const GLARE_FRAC = 0.10;      // >10% blown-out pixels = glare
const GLARE_PIXEL = 248;      // a pixel >= this counts as blown out
const EDGE_MIN = 0.035;       // edge density below this = no menu text in frame
const SHARP_MIN = 60;         // Laplacian variance below this = blurry
const MOTION_STEADY = 7;      // mean abs diff below this = holding steady
const REARM_MOTION = 14;      // movement above this re-arms after a capture
const STEADY_TICKS = 4;       // ~0.7s of steady before the shutter
const OFFCENTER = 0.22;       // centroid offset (0..0.5) before directional hint

const ESCALATE_MS = 5500;     // second-stage message after this long in a state
const BEST_SHOT_MS = 5000;    // content+light OK this long -> capture anyway
const STRUGGLE_MS = 20000;    // no capture at all -> hand over to manual
const HEARTBEAT_MS = 6000;    // reassure during long silence

const COUNTDOWN: Record<number, string> = {
  1: 'Hold still. Three.',
  2: 'Two.',
  3: 'One.',
};

// [first message, escalation with a concrete fix]
const STAGE_MSGS: Record<string, [string, string]> = {
  searching: [
    'Point the camera at the menu. Hold the phone flat, about a foot above it.',
    "I don't see menu text yet. Slide the phone slowly over the table until I find it, or tap Take photo to capture now.",
  ],
  dark: [
    "It's too dark to read. Move toward a window or a lamp.",
    'Still dark. Tilt the menu toward the nearest light, or ask for a phone flashlight. You can also tap Take photo and I will try anyway.',
  ],
  glare: [
    'There is a shiny glare on the menu. Tilt the phone slightly to one side.',
    'Still seeing glare. Move the menu away from the light above it, or stand so your shadow covers the shiny spot.',
  ],
  blur: [
    'The picture is blurry. Lift the phone a little higher, about a foot above the menu.',
    'Still blurry. Rest your elbows on the table to keep the phone steady, and hold it a bit further from the page.',
  ],
  moving: [
    'I can see the menu. Now hold still.',
    'Almost there. Rest your elbows on the table, take a breath, and hold the phone still. Or tap Take photo whenever you are ready.',
  ],
};

interface FrameMetrics {
  luminance: number;
  glareFrac: number;
  sharpness: number;
  edgeDensity: number;
  cx: number; // 0..1 centroid of edge energy
  cy: number;
  motion: number;
}

export class MenuScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D | null;
  private prev: Float32Array | null = null;
  private video: HTMLVideoElement | null = null;
  private cb: ScannerCallbacks | null = null;

  private armed = true;
  private armedAt = 0;
  private struggled = false;
  private steady = 0;
  private goodSince = 0;     // when lighting+content first became continuously OK
  private state: ScanState = 'searching';
  private coachStage = 0;
  private stateAt = 0;
  private lastCoachAt = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  start(video: HTMLVideoElement, cb: ScannerCallbacks) {
    this.stop();
    this.video = video;
    this.cb = cb;
    this.armed = true;
    this.struggled = false;
    this.steady = 0;
    this.goodSince = 0;
    this.prev = null;
    this.state = 'searching';
    this.coachStage = -1; // force first message
    this.stateAt = Date.now();
    this.lastCoachAt = Date.now();
    this.armedAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Release the detached <video>/stream and React closures (REVIEW.md #11).
    this.video = null;
    this.cb = null;
    this.prev = null;
  }

  /** Call after a capture so the scanner waits for movement before re-arming. */
  acknowledgeCapture() {
    this.armed = false;
    this.steady = 0;
    this.goodSince = 0;
    this.setState('disarmed');
  }

  private emit(msg: string) {
    this.lastCoachAt = Date.now();
    this.cb?.onCoach(msg);
  }

  private setState(next: ScanState, detail?: string) {
    if (next === this.state) return false;
    this.state = next;
    this.stateAt = Date.now();
    this.coachStage = -1;
    this.cb?.onState?.(next, detail);
    return true;
  }

  /** Speak stage-0 on entering a state, stage-1 after ESCALATE_MS, then silence. */
  private coachFor(state: ScanState, extra?: string) {
    const msgs = STAGE_MSGS[state];
    if (!msgs) return;
    const now = Date.now();
    if (this.coachStage < 0) {
      this.coachStage = 0;
      this.emit(extra ? `${msgs[0]} ${extra}` : msgs[0]);
    } else if (this.coachStage === 0 && now - this.stateAt > ESCALATE_MS) {
      this.coachStage = 1;
      this.emit(msgs[1]);
    } else if (this.coachStage === 1 && now - this.lastCoachAt > HEARTBEAT_MS * 3) {
      // After both staged messages, only a rare, state-neutral nudge — not an
      // every-6s nag in states where the canned text would be wrong (#10).
      this.emit('Still looking. Keep the menu under the camera.');
    }
  }

  private analyze(): FrameMetrics | null {
    const v = this.video;
    if (!v || !this.ctx || v.videoWidth === 0) return null;
    this.ctx.drawImage(v, 0, 0, W, H);
    const rgba = this.ctx.getImageData(0, 0, W, H).data;

    const gray = new Float32Array(W * H);
    let lumSum = 0;
    let glare = 0;
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      const g = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      gray[p] = g;
      lumSum += g;
      if (g >= GLARE_PIXEL) glare++;
    }
    const n = W * H;
    const luminance = lumSum / n;
    const glareFrac = glare / n;

    // Laplacian variance (blur) + edge density/centroid in one pass.
    let lapSum = 0, lapSq = 0;
    let edgeCount = 0, exSum = 0, eySum = 0, eTotal = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
        lapSum += lap;
        lapSq += lap * lap;
        const e = Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i - W]);
        if (e > 24) {
          edgeCount++;
          exSum += e * x;
          eySum += e * y;
          eTotal += e;
        }
      }
    }
    const inner = (W - 2) * (H - 2);
    const lapMean = lapSum / inner;
    const sharpness = lapSq / inner - lapMean * lapMean;
    const edgeDensity = edgeCount / inner;
    const cx = eTotal > 0 ? exSum / eTotal / W : 0.5;
    const cy = eTotal > 0 ? eySum / eTotal / H : 0.5;

    let motion = Infinity;
    if (this.prev) {
      let m = 0;
      for (let i = 0; i < gray.length; i++) m += Math.abs(gray[i] - this.prev[i]);
      motion = m / gray.length;
    }
    this.prev = gray;

    return { luminance, glareFrac, sharpness, edgeDensity, cx, cy, motion };
  }

  private fireCapture(reason: 'steady' | 'best_shot') {
    this.steady = 0;
    this.goodSince = 0;
    this.cb?.onState?.('steadying', `capture_${reason}`);
    this.emit(reason === 'steady' ? 'Capturing now.' : 'Good enough. Taking the photo now.');
    this.cb?.onProgress?.('steadying', STEADY_TICKS, STEADY_TICKS);
    this.cb?.onCapture();
  }

  private tick() {
    const m = this.analyze();
    if (!m || !this.cb) return;

    if (!this.armed) {
      this.cb.onProgress?.('disarmed', 0, STEADY_TICKS);
      if (m.motion > REARM_MOTION) {
        this.armed = true;
        this.armedAt = Date.now();
        this.struggled = false;
        this.setState('searching');
        this.coachStage = 0; // skip the long intro on re-arm
        this.emit('Ready for the next page.');
      }
      return;
    }

    // Only fall back to manual if the user is making NO progress. If they just
    // got steady (goodSince set, or steady ticks accumulating), a capture is
    // imminent — don't yank auto mode away right before it fires (REVIEW.md #9).
    if (
      !this.struggled &&
      this.steady === 0 &&
      !this.goodSince &&
      Date.now() - this.armedAt > STRUGGLE_MS
    ) {
      this.struggled = true;
      this.cb.onStruggle?.();
      return;
    }

    // Priority: dark -> glare -> content present -> blur -> steady.
    if (m.luminance < LUM_DARK) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('dark', `lum=${m.luminance.toFixed(0)}`);
      this.coachFor('dark');
      this.cb.onProgress?.('dark', 0, STEADY_TICKS);
      return;
    }

    if (m.glareFrac > GLARE_FRAC) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('glare', `glare=${(m.glareFrac * 100).toFixed(0)}%`);
      this.coachFor('glare');
      this.cb.onProgress?.('glare', 0, STEADY_TICKS);
      return;
    }

    if (m.edgeDensity < EDGE_MIN) {
      this.steady = 0;
      this.goodSince = 0;
      // Directional hint: where is the little detail we DO see?
      let dir: string | undefined;
      const dx = m.cx - 0.5;
      const dy = m.cy - 0.5;
      if (m.edgeDensity > EDGE_MIN * 0.3 && (Math.abs(dx) > OFFCENTER || Math.abs(dy) > OFFCENTER)) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          dir = dx > 0 ? 'I see something on the right. Move the phone slightly right.' : 'I see something on the left. Move the phone slightly left.';
        } else {
          dir = dy > 0 ? 'I see something near the bottom. Pull the phone toward you a little.' : 'I see something near the top. Push the phone away from you a little.';
        }
      }
      this.setState('searching', `edges=${(m.edgeDensity * 100).toFixed(1)}%`);
      this.coachFor('searching', dir);
      this.cb.onProgress?.('searching', 0, STEADY_TICKS);
      return;
    }

    // From here on lighting + content are OK — start the best-shot clock.
    if (!this.goodSince) this.goodSince = Date.now();
    const bestShotDue = Date.now() - this.goodSince > BEST_SHOT_MS;

    if (m.motion !== Infinity && m.motion <= MOTION_STEADY && m.sharpness < SHARP_MIN) {
      // Blurry while steady = focus/height problem, not hand shake.
      this.steady = 0;
      if (bestShotDue) { this.fireCapture('best_shot'); return; }
      this.setState('blur', `sharp=${m.sharpness.toFixed(0)}`);
      this.coachFor('blur');
      this.cb.onProgress?.('blur', 0, STEADY_TICKS);
      return;
    }

    if (m.motion === Infinity || m.motion > MOTION_STEADY) {
      this.steady = 0;
      if (bestShotDue && m.motion < REARM_MOTION) { this.fireCapture('best_shot'); return; }
      this.setState('moving', `motion=${m.motion === Infinity ? 'inf' : m.motion.toFixed(1)}`);
      this.coachFor('moving');
      this.cb.onProgress?.('moving', 0, STEADY_TICKS);
      return;
    }

    // Steady and sharp: countdown to capture.
    this.setState('steadying');
    this.steady++;
    if (this.steady >= STEADY_TICKS) {
      this.fireCapture('steady');
    } else {
      const msg = COUNTDOWN[this.steady];
      if (msg) this.emit(msg);
      this.cb.onProgress?.('steadying', this.steady, STEADY_TICKS);
    }
  }
}
