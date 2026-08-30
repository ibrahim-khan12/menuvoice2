// Guard: keep the words the user hears short and plain.
//
// Everything here is read aloud by a screen reader while someone is holding a
// phone over a table. A long sentence is one the listener is still hearing
// after the thing it describes has already changed, and an uncommon word is
// one they have to stop and decode. Neither is a style preference — both cost
// the user time at the exact moment they are trying to act.
//
// These are ceilings, not targets. They exist so the copy cannot quietly drift
// back toward paragraphs as features are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_MSGS, ROTATE_MSGS, COUNTDOWN } from '../src/lib/scanner.ts';
import { FIRST_RUN_STEPS, STEPS } from '../src/screens/TutorialScreen.tsx';

/** Spoken over and over during capture — the tightest budget in the app. */
const COACH_MAX = 80;
/** Read once, when the user chooses to read it. */
const TUTORIAL_MAX = 100;
/** Past this a sentence is doing too much at once. */
const SENTENCE_MAX = 60;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

/**
 * Words that make a reader stop and decode. Deliberately small and concrete:
 * each one appeared in this app's copy at some point and has a plainer
 * equivalent that says the same thing.
 */
const JARGON: [RegExp, string][] = [
  [/\bactivate\b/i, 'choose / tap'],
  [/\butilize\b/i, 'use'],
  [/\bsubsequent(ly)?\b/i, 'next / then'],
  [/\bprior to\b/i, 'before'],
  [/\bin order to\b/i, 'to'],
  [/\bapproximately\b/i, 'about'],
  [/\badditional(ly)?\b/i, 'more / also'],
  [/\bcommence\b/i, 'start'],
  [/\bterminate\b/i, 'stop'],
  [/\bindicate\b/i, 'show / say'],
  [/\binterruption\b/i, 'talking over you'],
  [/\bsimultaneous(ly)?\b/i, 'at once'],
  [/\bconfigure\b/i, 'set'],
  [/\bnavigate to\b/i, 'go to'],
];

function assertPlain(label: string, text: string) {
  for (const [re, plainer] of JARGON) {
    assert.ok(!re.test(text), `${label}: uses "${text.match(re)?.[0]}" — say "${plainer}" instead.\n  ${text}`);
  }
}

test('capture coaching stays short enough to act on', () => {
  const all: [string, string][] = [
    ...Object.entries(STAGE_MSGS).flatMap(([state, [first, second]]) =>
      [[`${state}[0]`, first], [`${state}[1]`, second]] as [string, string][]
    ),
    ...Object.entries(ROTATE_MSGS).map(([k, v]) => [`rotate.${k}`, v] as [string, string]),
    ...Object.entries(COUNTDOWN).map(([k, v]) => [`countdown.${k}`, v] as [string, string]),
  ];
  for (const [label, msg] of all) {
    assert.ok(
      msg.length <= COACH_MAX,
      `${label} is ${msg.length} chars (max ${COACH_MAX}) — this plays while the user is moving a phone:\n  ${msg}`
    );
  }
});

test('no single spoken sentence tries to do too much', () => {
  const all = [
    ...Object.values(STAGE_MSGS).flat(),
    ...Object.values(ROTATE_MSGS),
  ];
  for (const msg of all) {
    for (const s of sentences(msg)) {
      assert.ok(
        s.length <= SENTENCE_MAX,
        `a spoken sentence is ${s.length} chars (max ${SENTENCE_MAX}); split it:\n  ${s}`
      );
    }
  }
});

test('capture coaching avoids words the user has to decode', () => {
  for (const [state, pair] of Object.entries(STAGE_MSGS)) {
    pair.forEach((msg, i) => assertPlain(`${state}[${i}]`, msg));
  }
  for (const [k, v] of Object.entries(ROTATE_MSGS)) assertPlain(`rotate.${k}`, v);
});

test('tutorial steps stay short', () => {
  for (const [name, list] of [['first run', FIRST_RUN_STEPS], ['full', STEPS]] as const) {
    for (const step of list) {
      assert.ok(
        step.body.length <= TUTORIAL_MAX,
        `${name} step "${step.title}" is ${step.body.length} chars (max ${TUTORIAL_MAX}):\n  ${step.body}`
      );
      assert.ok(step.title.length <= 30, `${name} step title too long: "${step.title}"`);
    }
  }
});

test('tutorial steps avoid words the user has to decode', () => {
  for (const [name, list] of [['first run', FIRST_RUN_STEPS], ['full', STEPS]] as const) {
    for (const step of list) assertPlain(`${name} "${step.title}"`, step.body);
  }
});

// ── The step that is easy to leave out ──────────────────────────────────────
// Taking photos does not start the reading. Nothing happens until "Read menu"
// is activated. A blind user who does not know that is left holding a phone
// full of photos wondering why the app has gone quiet, so both tutorials have
// to say it.

test('both tutorials tell the user they must tap Read menu after taking photos', () => {
  for (const [name, list] of [['first run', FIRST_RUN_STEPS], ['full', STEPS]] as const) {
    const text = list.map((s) => `${s.title} ${s.body}`).join(' ');
    assert.match(
      text,
      /Read menu/,
      `the ${name} tutorial never mentions "Read menu" — photos are not read until the user taps it`
    );
  }
});

test('the Read menu step explains that nothing is read until it is tapped', () => {
  for (const list of [FIRST_RUN_STEPS, STEPS]) {
    const step = list.find((s) => /Read menu/.test(s.title));
    assert.ok(step, 'there should be a step whose title names Read menu');
    assert.match(
      step!.body,
      /not read until/i,
      `the step should say plainly that photos are not read until then:\n  ${step!.body}`
    );
  }
});
