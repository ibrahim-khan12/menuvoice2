import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apiUrl } from '../src/lib/apiUrl.ts';
import { hasApiKey } from '../src/lib/openai.ts';
import { canUseNativeRecorderFallback } from '../src/lib/speechRecognition.ts';
import { isAllowedEventOrigin } from '../api/events.ts';

test('web API requests remain same-origin', () => {
  assert.equal(apiUrl('/api/tts', false), '/api/tts');
});

test('native API requests use the production backend', () => {
  assert.equal(apiUrl('/api/tts', true), 'https://app.meetmymenu.com/api/tts');
  assert.equal(
    apiUrl('/api/transcribe?cartesiaToken=1', true),
    'https://app.meetmymenu.com/api/transcribe?cartesiaToken=1',
  );
});

test('native Capacitor localhost uses the production API proxy', () => {
  assert.equal(hasApiKey('localhost', true), true);
});

test('web localhost still requires a direct development key', () => {
  assert.equal(hasApiKey('localhost', false), false);
});

test('client API calls use the native-aware URL helper', () => {
  const root = path.resolve(import.meta.dirname, '..', 'src');
  const files = [
    path.join(root, 'lib', 'storage.ts'),
    path.join(root, 'lib', 'telemetry.ts'),
    path.join(root, 'screens', 'CaptureScreen.tsx'),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:fetch|sendBeacon)\(\s*['"]\/api\//, file);
  }
});

test('conversation speech retains an audible fallback on native', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'lib', 'speech.ts'),
    'utf8',
  );
  assert.match(source, /const ALLOW_BROWSER_TTS_FALLBACK = true;/);
  assert.match(source, /await playBrowser\(text, epoch\)/);
  assert.match(source, /await playBrowser\(sentence, myEpoch\)/);
});

test('native iOS can fall back from realtime STT to MediaRecorder', () => {
  assert.equal(canUseNativeRecorderFallback(true, true), true);
  assert.equal(canUseNativeRecorderFallback(false, true), false);
  assert.equal(canUseNativeRecorderFallback(true, false), false);
});

test('telemetry accepts only the exact native app origin or deployment host', () => {
  assert.equal(isAllowedEventOrigin('app.meetmymenu.com', 'capacitor://localhost'), true);
  assert.equal(isAllowedEventOrigin('app.meetmymenu.com', 'capacitor://localhost/'), true);
  assert.equal(isAllowedEventOrigin('app.meetmymenu.com', 'https://app.meetmymenu.com'), true);
  assert.equal(isAllowedEventOrigin('app.meetmymenu.com', 'https://attacker.example'), false);
  assert.equal(isAllowedEventOrigin('app.meetmymenu.com', 'capacitor://attacker'), false);
});
