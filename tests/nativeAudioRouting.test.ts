import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl } from '../src/lib/apiUrl.ts';

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
