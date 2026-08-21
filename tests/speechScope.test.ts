// Bug #9: Meet My Menu AI's own text-to-speech must run ONLY on the Conversation
// screen. Every other screen speaks through headings, focus movement, and
// aria-live regions for VoiceOver instead.
//
// A manual audit confirmed every real speak()/createStreamingSpeech() call
// site lives in ConversationScreen.tsx (the other window.speechSynthesis.speak
// calls, in audioUnlock.ts and speech.ts's own unlockAudio(), are silent
// volume:0 priming utterances used to satisfy the mobile autoplay gate, not
// audible content). This test is the automated guard against regression: if a
// future change imports real speech into another screen, it fails here
// instead of needing another manual trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS_DIR = join(import.meta.dirname, '..', 'src', 'screens');
const ALLOWED_SCREENS = ['ConversationScreen.tsx', 'CaptureScreen.tsx'];

// Functions that produce audible spoken content. Everything else exported by
// lib/speech (stopSpeaking, isSpeaking, setSpeechRate, unlockAudio) is safe
// off Conversation: they silence, query, configure, or prime — none of them
// make Meet My Menu AI talk.
const SPEECH_PRODUCING_EXPORTS = ['speak', 'createStreamingSpeech'];

const IMPORT_FROM_SPEECH_MODULE =
  /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/lib\/speech(?:\.[jt]sx?)?['"]/g;

function importedSpeechNames(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_FROM_SPEECH_MODULE)) {
    for (const raw of match[1].split(',')) {
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (name) found.push(name);
    }
  }
  return found;
}

function screenFiles(): string[] {
  return readdirSync(SCREENS_DIR).filter((f) => f.endsWith('.tsx'));
}

test('every screen file exists where this guard expects it', () => {
  const files = screenFiles();
  assert.ok(files.includes('ConversationScreen.tsx'), 'ConversationScreen.tsx should exist');
  assert.ok(files.includes('CaptureScreen.tsx'), 'CaptureScreen.tsx should exist');
  assert.ok(files.length >= 9, 'sanity check: the screens directory should not be empty');
});

test('only Conversation and Capture import a speech-producing function', () => {
  const violations: string[] = [];
  for (const file of screenFiles()) {
    if (ALLOWED_SCREENS.includes(file)) continue;
    const source = readFileSync(join(SCREENS_DIR, file), 'utf8');
    const banned = importedSpeechNames(source).filter((n) => SPEECH_PRODUCING_EXPORTS.includes(n));
    if (banned.length) violations.push(`${file}: imports ${banned.join(', ')}`);
  }
  assert.deepEqual(violations, [], 'app-generated speech must be confined to Conversation and Capture');
});

test('the guard actually detects a violation (regex sanity check)', () => {
  const planted = `import { speak, stopSpeaking } from '../lib/speech';\nspeak('hello');`;
  const names = importedSpeechNames(planted).filter((n) => SPEECH_PRODUCING_EXPORTS.includes(n));
  assert.deepEqual(names, ['speak'], 'the detector must catch a real violation, not just pass trivially');
});

test('Conversation screen does use the speech-producing functions', () => {
  const source = readFileSync(join(SCREENS_DIR, 'ConversationScreen.tsx'), 'utf8');
  const names = importedSpeechNames(source);
  assert.ok(names.includes('speak'), 'sanity check: Conversation should import speak');
  assert.ok(names.includes('createStreamingSpeech'), 'sanity check: Conversation should import createStreamingSpeech');
});
