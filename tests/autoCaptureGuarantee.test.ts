// Auto capture must actually fire — in the conditions a real restaurant
// actually presents, not just in a clean one.
//
// The scanner's quality gates each returned early AND zeroed the best-shot
// clock, so a single persistent problem pinned the countdown at zero forever:
// glare on a laminated menu, a page slightly larger than the frame, a few
// degrees of tilt nobody can feel. After 20s the app then switched auto
// capture off and asked the user to tap the shutter — handing the framing
// problem to the one person who cannot see it.
//
// Every scenario below is a condition that produced NO capture at all before,
// and each asserts a capture within a bounded time. The last two are the
// counterweight: the guarantee must not degrade into photographing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Controllable clock ──────────────────────────────────────────────────────
// Patience is measured in wall-clock time, so the tests need to own it.
const REAL_NOW = Date.now;
let clock = 1_700_000_000_000;
(Date as unknown as { now: () => number }).now = () => clock;

const TICK_MS = 170; // must match the scanner's own tick interval

interface Conditions {
  /** Fraction of the frame blown out to pure white. */
  glare?: number;
  /** Mean brightness target; low values simulate a dim dining room. */
  dim?: boolean;
  /** Stripe angle in degrees — the page's tilt. */
  tilt?: number;
  /** Page fills the whole frame (bleeds off every edge). */
  oversized?: boolean;
  /** Page sits well inside the frame — readable, but "too far" by the rule. */
  distant?: boolean;
  /**
   * Uniform per-frame brightness delta. Inter-frame mean-abs-diff is exactly
   * this, so it sets `motion` directly without disturbing edges, bbox or skew
   * — unsteady hands isolated from every other metric.
   */
  jitter?: number;
  /** Nothing readable at all: a blank surface. */
  blank?: boolean;
  /** Soft focus: reduces edge contrast without removing it. */
  soft?: boolean;
}

const BUF = { w: 104, h: 185 }; // what analysisSize gives a 9:16 phone

function renderFrame(c: Conditions, frameIndex: number): Uint8ClampedArray {
  const { w, h } = BUF;
  const rgba = new Uint8ClampedArray(w * h * 4);
  // Odd frames sit `jitter` brighter than even ones, giving an exact motion value.
  const jitter = frameIndex % 2 === 1 ? (c.jitter ?? 0) : 0;

  // Page bounds.
  let x0 = Math.round(w * 0.06), x1 = Math.round(w * 0.94);
  let y0 = Math.round(h * 0.2), y1 = Math.round(h * 0.8);
  if (c.oversized) { x0 = 0; x1 = w - 1; y0 = 0; y1 = h - 1; }
  if (c.distant) {
    // ~41% of each dimension: under TOO_FAR_BBOX on both axes, so the rule
    // calls it too far, but with plenty of legible text actually present.
    x0 = Math.round(w * 0.295); x1 = Math.round(w * 0.705);
    y0 = Math.round(h * 0.295); y1 = Math.round(h * 0.705);
  }

  const dark = c.dim ? 8 : 40;
  const light = c.dim ? 44 : 220;
  const contrast = c.soft ? 0.45 : 1; // soft focus flattens, never erases
  const lo = Math.round(dark + (light - dark) * (1 - contrast) / 2);
  const hi = Math.round(light - (light - dark) * (1 - contrast) / 2);
  const bg = c.dim ? 26 : 180;

  const rad = ((c.tilt ?? 0) * Math.PI) / 180;
  const nx = -Math.sin(rad), ny = Math.cos(rad);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v: number;
      if (c.blank) {
        v = bg;
      } else if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        const d = x * nx + y * ny;
        v = Math.floor(d / 6) % 2 === 0 ? lo : hi;
      } else {
        v = bg;
      }
      const p = (y * w + x) * 4;
      const jv = Math.max(0, Math.min(255, v + jitter));
      rgba[p] = rgba[p + 1] = rgba[p + 2] = jv;
      rgba[p + 3] = 255;
    }
  }

  // Blow out a contiguous band to simulate a specular reflection.
  if (c.glare) {
    const rows = Math.ceil(h * c.glare);
    const start = Math.floor((h - rows) / 2);
    for (let y = start; y < start + rows; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = 255;
      }
    }
  }
  return rgba;
}

let conditions: Conditions = {};
let frameIndex = 0;

const fakeCtx = {
  drawImage() {},
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: renderFrame(conditions, frameIndex), width: w, height: h };
  },
};
(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx }),
};

const { MenuScanner, RELAX_NOTICE } = await import('../src/lib/scanner.ts');

interface Outcome {
  captured: boolean;
  /** Simulated milliseconds from arming to the first capture. */
  atMs: number | null;
  reasons: string[];
  coach: string[];
  struggled: boolean;
}

/**
 * Hold `c` steady and run the scanner until it captures or `maxMs` elapses.
 * `zoomable` models a camera whose zoom the scanner can actually drive.
 */
function scan(c: Conditions, maxMs = 30000, zoomable = false): Outcome {
  conditions = c;
  frameIndex = 0;
  clock = 1_700_000_000_000;

  const coach: string[] = [];
  const reasons: string[] = [];
  let struggled = false;
  let atMs: number | null = null;
  const started = clock;

  const scanner: any = new MenuScanner();
  scanner.start({ videoWidth: 1080, videoHeight: 1920 } as any, {
    onCoach: (msg: string) => coach.push(msg),
    onCapture: () => { if (atMs === null) atMs = clock - started; },
    onStruggle: () => { struggled = true; },
    onState: (_s: string, detail?: string) => {
      if (detail?.startsWith('capture_')) reasons.push(detail.replace('capture_', ''));
    },
    ...(zoomable ? { onAutoZoom: () => true } : {}),
  });

  const ticks = Math.ceil(maxMs / TICK_MS);
  for (let i = 0; i < ticks && atMs === null; i++) {
    frameIndex = i;
    scanner.tick();
    clock += TICK_MS;
  }
  scanner.stop();
  return { captured: atMs !== null, atMs, reasons, coach, struggled };
}

/** Every realistic scenario must capture, and within a tolerable wait. */
const MUST_CAPTURE_BY_MS = 18000;

function assertCaptures(label: string, c: Conditions, opts: { zoomable?: boolean } = {}) {
  const r = scan(c, 30000, opts.zoomable);
  assert.ok(
    r.captured,
    `${label}: auto capture NEVER fired in 30s. Coaching was:\n  ${r.coach.join('\n  ')}`
  );
  assert.ok(
    r.atMs! <= MUST_CAPTURE_BY_MS,
    `${label}: captured only after ${(r.atMs! / 1000).toFixed(1)}s, which is longer than anyone will hold a phone over a menu`
  );
  return r;
}

// ── The conditions that used to stall forever ───────────────────────────────

test('glare on a laminated menu still gets photographed', () => {
  // A ceiling light on a laminated page — well past the 10% glare threshold.
  assertCaptures('laminated glare', { glare: 0.2 });
});

test('a dim dining room still gets photographed', () => {
  assertCaptures('dim room', { dim: true });
});

test('a menu larger than the frame still gets photographed', () => {
  // Bleeds off every edge, and the camera has no zoom to back out with.
  assertCaptures('oversized page', { oversized: true });
});

test('a menu larger than the frame is photographed even when zoom keeps failing to help', () => {
  // Zoom accepts every step but the page still fills the frame — the old code
  // would happily loop on this forever.
  assertCaptures('oversized page, zoom available', { oversized: true }, { zoomable: true });
});

test('a persistently tilted page still gets photographed', () => {
  // 30 degrees: far past the warn threshold, and a blind user has no way to
  // know they are holding it crooked.
  assertCaptures('tilted page', { tilt: 30 });
});

test('a distant menu still gets photographed when zoom cannot reach it', () => {
  assertCaptures('distant page', { distant: true });
});

test('unsteady hands still get a photograph', () => {
  // motion ~12: past the steady threshold of 7, the shake of a real hand held
  // out over a table. Previously this sat in 'moving' indefinitely.
  assertCaptures('unsteady hands', { jitter: 12 });
});

test('a menu is photographed the moment a shaking hand settles', () => {
  // Violent movement for the first seconds, then the user steadies. The
  // scanner must be waiting and fire promptly, not still be stuck in a gate.
  conditions = { jitter: 60 };
  frameIndex = 0;
  clock = 1_700_000_000_000;
  const started = clock;
  let atMs: number | null = null;
  const scanner: any = new MenuScanner();
  scanner.start({ videoWidth: 1080, videoHeight: 1920 } as any, {
    onCoach: () => {},
    onCapture: () => { if (atMs === null) atMs = clock - started; },
  });
  for (let i = 0; i < 180 && atMs === null; i++) {
    // Settle down after 5 simulated seconds.
    conditions = clock - started > 5000 ? {} : { jitter: 60 };
    frameIndex = i;
    scanner.tick();
    clock += TICK_MS;
  }
  scanner.stop();
  assert.ok(atMs !== null, 'never captured even after the hand steadied');
  assert.ok(atMs! < 8000, `took ${atMs}ms to notice the hand had settled`);
});

test('a frame smeared beyond reading is correctly NOT captured', () => {
  // Documents the one floor that never gives way: mid-swing motion produces a
  // smear no model can read, so firing anyway would only waste a retake.
  const r = scan({ jitter: 90 });
  assert.equal(r.captured, false, 'a smeared frame is worth less than waiting');
});

test('soft focus still gets a photograph', () => {
  assertCaptures('soft focus', { soft: true });
});

// ── The realistic compound case ─────────────────────────────────────────────

test('the whole realistic mess at once still gets photographed', () => {
  // Dim room, laminated glare, page bigger than the frame, held crooked, in
  // an unsteady hand. This is a restaurant table, and it captured nothing.
  const r = assertCaptures('everything at once', {
    dim: true, glare: 0.15, oversized: true, tilt: 26, shake: 2,
  });
  assert.ok(
    r.reasons.length > 0,
    'the capture should record why it fired, for telemetry'
  );
});

test('auto capture is never switched off while a menu is in view', () => {
  const r = scan({ dim: true, glare: 0.15, oversized: true, tilt: 26, shake: 2 });
  assert.equal(
    r.struggled,
    false,
    'handing a framing problem to someone who cannot see it is the opposite of help'
  );
});

test('the user is told the bar has dropped, rather than being coached at until the shutter surprises them', () => {
  const r = assertCaptures('relax notice', { tilt: 30 });
  assert.ok(
    r.coach.includes(RELAX_NOTICE),
    `expected a heads-up that we will take it anyway; got:\n  ${r.coach.join('\n  ')}`
  );
});

test('a forced capture says so, so the user knows to expect a quality warning', () => {
  const r = scan({ dim: true, glare: 0.15, oversized: true, tilt: 26, shake: 2 });
  const spoken = r.coach.join(' ');
  assert.ok(
    /Capturing now|Taking the photo now|Good enough/.test(spoken),
    `the capture should always be announced out loud; got:\n  ${r.coach.join('\n  ')}`
  );
});

// ── The guarantee must not become "photograph anything" ─────────────────────

test('a blank surface is NOT photographed — there is nothing to read', () => {
  const r = scan({ blank: true });
  assert.equal(r.captured, false, 'photographing a blank table wastes the user’s time');
  assert.equal(r.struggled, true, 'but the user should be told the camera cannot see a menu');
});

test('a covered lens is NOT photographed', () => {
  const r = scan({ blank: true, dim: true });
  assert.equal(r.captured, false);
  assert.equal(r.struggled, true, 'and manual is offered as a second option');
});

test('a good frame still captures quickly — the guarantee does not slow the happy path', () => {
  const r = assertCaptures('clean menu', {});
  assert.ok(
    r.atMs! < 2000,
    `a clean, well-framed menu should capture almost immediately, took ${r.atMs}ms`
  );
  assert.equal(r.reasons[0], 'steady', 'and should capture on genuine steadiness, not a forced shot');
});

test('a good frame is not degraded by the relaxed path — no forced capture when unnecessary', () => {
  const r = scan({});
  assert.ok(!r.reasons.includes('forced'), 'a clean frame must never need forcing');
  assert.ok(
    !r.coach.some((c) => c.includes('close enough to read')),
    'and the user should not be told we are lowering the bar when we are not'
  );
});

test.after(() => { (Date as unknown as { now: () => number }).now = REAL_NOW; });
