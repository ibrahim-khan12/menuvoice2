import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenHasNonce } from '../src/lib/googleNonce';

function unsignedToken(payload: object): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
}

test('accepts an ID token only when it has the expected nonce', () => {
  assert.equal(tokenHasNonce(unsignedToken({ nonce: 'expected' }), 'expected'), true);
  assert.equal(tokenHasNonce(unsignedToken({ nonce: 'other' }), 'expected'), false);
});

test('rejects malformed ID tokens', () => {
  assert.equal(tokenHasNonce('not-a-token', 'expected'), false);
});
