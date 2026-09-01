// Paced announcements for the capture screen's live region.
//
// Reported after a real test with a paper menu: "It doesn't get to read the
// full thing. It'll start reading it, and then a new message will pop up so
// quickly it just interrupts it." And, as a direct consequence, "it doesn't
// tell the person to switch the page" — that message lands exactly when
// coaching resumes, so it was the one most reliably destroyed.
//
// A screen reader restarts the moment a live region's text changes, so the fix
// is to stop changing it so fast. These tests own the clock, so they check the
// pacing itself rather than wall-clock timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacedAnnouncer, readingTimeMs } from '../src/lib/announcer.ts';
import { readFileSync } from 'node:fs';

function harness() {
  let clock = 0;
  const seen: string[] = [];
  const a = new PacedAnnouncer((t) => seen.push(t), () => clock);
  return {
    a,
    seen,
    advance(ms: number) { clock += ms; a.pump(); },
    get now() { return clock; },
  };
}

test('reading time grows with length and stays inside sane bounds', () => {
  assert.equal(readingTimeMs(''), 0);
  const short = readingTimeMs('Too dark.');
  const long = readingTimeMs('Photo 1 taken. Turn to the next page, or tap Read menu.');
  assert.ok(long > short, `"${long}" should exceed "${short}"`);
  assert.ok(short >= 1300, 'even a two-word message needs a beat');
  assert.ok(readingTimeMs('word '.repeat(200)) <= 4500, 'and nothing blocks the region for too long');
});

test('a second message does not cut off the first', () => {
  const h = harness();
  h.a.announce('Too dark. Move toward a light.');
  assert.deepEqual(h.seen, ['Too dark. Move toward a light.']);

  // Coaching arrives again almost immediately, as it does at ~6fps.
  h.advance(170);
  h.a.announce('I can see it. Hold still.');
  assert.deepEqual(h.seen, ['Too dark. Move toward a light.'], 'the first message was still being read');
});

test('the next message appears once the first has had time to be heard', () => {
  const h = harness();
  h.a.announce('Too dark. Move toward a light.');
  h.a.announce('I can see it. Hold still.');
  h.advance(readingTimeMs('Too dark. Move toward a light.') + 10);
  assert.deepEqual(h.seen, ['Too dark. Move toward a light.', 'I can see it. Hold still.']);
});

test('a flood of coaching leaves only the newest — never a stale backlog', () => {
  const h = harness();
  h.a.announce('first');
  for (const msg of ['second', 'third', 'fourth', 'fifth']) {
    h.advance(50);
    h.a.announce(msg);
  }
  h.advance(5000);
  assert.deepEqual(
    h.seen,
    ['first', 'fifth'],
    'advice for a position the phone has already left is worse than silence'
  );
});

// ── The reported bug ────────────────────────────────────────────────────────

test('"turn to the next page" survives coaching resuming right on top of it', () => {
  // Timestamped, so this measures how long the message actually held the
  // region rather than merely that it appeared at some point.
  let clock = 0;
  const shown: { text: string; at: number }[] = [];
  const a = new PacedAnnouncer((text) => shown.push({ text, at: clock }), () => clock);
  const advance = (ms: number) => { clock += ms; a.pump(); };

  const CONFIRM = 'Photo 1 taken. Turn to the next page, or tap Read menu.';

  a.announce('I can see it. Hold still.');
  advance(200);

  // The shutter fires. This must land now, not once stale coaching finishes.
  a.announce(CONFIRM, 'urgent');
  assert.equal(shown[shown.length - 1].text, CONFIRM, 'the confirmation must displace coaching at once');
  const confirmedAt = shown[shown.length - 1].at;

  // The scanner starts coaching again immediately, as it really does at ~6fps.
  // Long enough that coaching must get its turn back (the confirmation holds
  // the region for ~3.5s; this runs 5s of frames at the real tick rate).
  for (let i = 0; i < 30; i++) {
    advance(170);
    a.announce(`Hold still, attempt ${i}.`);
  }

  const next = shown.find((s) => s.at > confirmedAt);
  assert.ok(next, 'coaching should eventually resume');
  const held = next!.at - confirmedAt;
  assert.ok(
    held >= readingTimeMs(CONFIRM),
    `the confirmation held the region for only ${held}ms, needs ${readingTimeMs(CONFIRM)}ms — this is the interruption the tester heard`
  );
});

test('two photos in a row both get announced — neither is swallowed', () => {
  const h = harness();
  h.a.announce('Photo 1 taken. Turn to the next page, or tap Read menu.', 'urgent');
  h.advance(300);
  h.a.announce('Photo 2 taken. Turn to the next page, or tap Read menu.', 'urgent');
  h.advance(9000);
  assert.deepEqual(h.seen, [
    'Photo 1 taken. Turn to the next page, or tap Read menu.',
    'Photo 2 taken. Turn to the next page, or tap Read menu.',
  ]);
});

test('an urgent message clears pending coaching rather than queueing behind it', () => {
  const h = harness();
  h.a.announce('Too dark. Move toward a light.');
  h.advance(100);
  h.a.announce('Still dark. Tilt the menu toward a light.'); // queued
  h.a.announce('Photo 1 taken. Turn to the next page.', 'urgent');
  h.advance(9000);
  assert.ok(
    !h.seen.includes('Still dark. Tilt the menu toward a light.'),
    'stale coaching must not surface after the photo was already taken'
  );
  assert.ok(h.seen.includes('Photo 1 taken. Turn to the next page.'));
});

test('the same text is never announced twice in a row', () => {
  const h = harness();
  h.a.announce('Hold still.');
  h.advance(9000);
  h.a.announce('Hold still.');
  h.advance(9000);
  assert.deepEqual(h.seen, ['Hold still.'], 're-announcing identical text restarts the reader for nothing');
});

test('empty text never displaces a real message', () => {
  const h = harness();
  h.a.announce('Photo 1 taken.', 'urgent');
  h.advance(9000);
  h.a.announce('');
  h.advance(9000);
  assert.deepEqual(h.seen, ['Photo 1 taken.']);
});

// ── Screen wiring ───────────────────────────────────────────────────────────
// Source-level guards. These phrases are inline in the screen, and each one is
// a specific thing a tester could not work out from the app.

const captureSrc = readFileSync(new URL('../src/screens/CaptureScreen.tsx', import.meta.url), 'utf8');

test('the capture screen has exactly one live region', () => {
  const regions = captureSrc.match(/aria-live="polite"/g) ?? [];
  assert.equal(
    regions.length,
    1,
    'two live regions updating independently is what caused the interruptions'
  );
});

test('a captured photo gives a concise next-page instruction and pauses scanning', () => {
  assert.match(
    captureSrc,
    /Picture taken\. Move to the next page\./,
    'without this people do not know the app is ready for another page, and just wait'
  );
  assert.match(captureSrc, /const PAGE_TURN_PAUSE_MS = 5000;/);
  assert.match(captureSrc, /!scannerPaused/);
  assert.match(captureSrc, /pauseForPageTurn\(\);/);
});

test('a bad capture gives one concise retake instruction', () => {
  assert.match(captureSrc, /Picture may be hard to read\. Retake last photo\./);
});

test('EVERY message about retaking names the button that does it', () => {
  // Checking one phrase was not enough: the upload path had its own "Consider
  // retaking it" that this test originally sailed past, and that is the exact
  // message the tester saw. So check all of them.
  const strings = [...captureSrc.matchAll(/`([^`]*)`|'([^'\\]*)'/g)]
    .map((m) => m[1] ?? m[2])
    .filter((s) => /\bretak/i.test(s) && /[a-z] [a-z]/.test(s));
  assert.ok(strings.length > 0, 'there should be messages about retaking');
  for (const s of strings) {
    // The button's own label and hint are what the message points AT.
    if (s.startsWith('Retake last photo') || s.startsWith('The last photo may')) continue;
    if (s.startsWith('Remove the last photo')) continue;
    assert.match(
      s,
      /Retake last photo/,
      `"retake it" is not an instruction if you cannot see which control does that:\n  ${s}`
    );
  }
});

test('no message tells the user to "consider" doing something', () => {
  assert.doesNotMatch(
    captureSrc,
    /Consider retaking/,
    'a suggestion to consider something is not an instruction someone can follow'
  );
});

test('Read menu is rendered above the camera preview, not below the controls', () => {
  const readMenu = captureSrc.indexOf('Read menu (');
  const preview = captureSrc.indexOf('className="capture-preview"');
  assert.ok(readMenu > 0 && preview > 0, 'both should exist');
  assert.ok(
    readMenu < preview,
    'Read menu should come before the preview so it is reachable without swiping the whole screen'
  );
});

test('the camera does not start at a zoom so wide the text cannot be read', () => {
  const m = captureSrc.match(/const DEFAULT_ZOOM = ([\d.]+)/);
  assert.ok(m, 'DEFAULT_ZOOM should be a named constant');
  const zoom = Number(m![1]);
  assert.ok(
    zoom >= 0.7,
    `starting zoom is ${zoom}x — held above a table that renders menu text too small to read`
  );
  assert.ok(zoom <= 1, `starting zoom is ${zoom}x — a whole page should still fit`);
});
