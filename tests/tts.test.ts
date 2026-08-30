import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTtsCors, CARTESIA_TTS_MODEL_DEFAULT, resolveSpeechSpeed } from '../api/tts.ts';

function corsHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {};
  applyTtsCors(
    { headers: { origin } } as any,
    { setHeader: (name: string, value: string) => { headers[name] = value; } } as any,
  );
  return headers;
}

test('Cartesia defaults to a model that supports speed control', () => {
  assert.equal(CARTESIA_TTS_MODEL_DEFAULT, 'sonic-3');
});

test('requested speech speed overrides the configured default', () => {
  assert.equal(resolveSpeechSpeed({ speed: 1.4 }, '0.8'), 1.4);
});

test('speech speed is clamped to the provider-safe range', () => {
  assert.equal(resolveSpeechSpeed({ speed: 0.1 }, '1'), 0.5);
  assert.equal(resolveSpeechSpeed({ speed: 4 }, '1'), 2);
});

test('speech speed falls back to configuration and then normal speed', () => {
  assert.equal(resolveSpeechSpeed({}, '0.7'), 0.7);
  assert.equal(resolveSpeechSpeed({}, 'not-a-number'), 1);
});

test('native TTS preflight allows only the signed Capacitor origin', () => {
  assert.equal(corsHeaders('capacitor://localhost')['Access-Control-Allow-Origin'], 'capacitor://localhost');
  assert.equal(corsHeaders('https://attacker.example')['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders('capacitor://attacker')['Access-Control-Allow-Origin'], undefined);
});
