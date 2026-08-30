// Bug #20 (server half): /api/sync must never trust a client-supplied email.
// Identity now comes only from a cryptographically verified token.
//
// verifyGoogleIdToken can't be tested against real Google servers without a
// live browser OAuth flow (same device-only caveat as bugs #14/#15), so this
// suite generates its OWN RSA keypair and signs tokens exactly as Google
// would, passing the public key in as verifyGoogleIdToken's injectable getKey
// override. That exercises the exact same jose verification logic
// (signature, issuer, audience, expiry) that runs against the real Google
// JWKS in production — only the source of the public key differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair } from 'jose';

process.env.SESSION_SECRET = 'test-session-secret-not-for-production-use-only';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.APPLE_CLIENT_ID = 'com.meetmymenu.app.web';

const { verifyGoogleIdToken, verifyAppleIdToken, createSessionToken, verifySessionToken, bearerToken } =
  await import('../server/auth.ts');

const { publicKey, privateKey } = await generateKeyPair('RS256');

async function signGoogleLikeToken(claims: Record<string, unknown>, opts: { expSec?: number } = {}) {
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(opts.expSec ? Math.floor(Date.now() / 1000) + opts.expSec : '1h')
    .sign(privateKey);
}

// ── verifyGoogleIdToken ──────────────────────────────────────────────────

test('accepts a validly signed, correctly audienced, verified-email token', async () => {
  const token = await signGoogleLikeToken({
    email: 'Diner@Example.com',
    iss: 'https://accounts.google.com',
    aud: 'test-client-id.apps.googleusercontent.com',
  });
  const result = await verifyGoogleIdToken(token, publicKey);
  assert.deepEqual(result, { email: 'diner@example.com' }, 'email is lowercased/trimmed');
});

test('rejects a token for the wrong audience (a different app)', async () => {
  const token = await signGoogleLikeToken({
    email: 'diner@example.com',
    iss: 'https://accounts.google.com',
    aud: 'some-other-app.apps.googleusercontent.com',
  });
  assert.equal(await verifyGoogleIdToken(token, publicKey), null);
});

test('rejects a token from the wrong issuer', async () => {
  const token = await signGoogleLikeToken({
    email: 'diner@example.com',
    iss: 'https://not-google.example.com',
    aud: 'test-client-id.apps.googleusercontent.com',
  });
  assert.equal(await verifyGoogleIdToken(token, publicKey), null);
});

test('rejects a token whose email Google did not verify', async () => {
  const token = await signGoogleLikeToken({
    email: 'diner@example.com',
    email_verified: false,
    iss: 'https://accounts.google.com',
    aud: 'test-client-id.apps.googleusercontent.com',
  });
  assert.equal(await verifyGoogleIdToken(token, publicKey), null);
});

test('rejects an expired token', async () => {
  const token = await signGoogleLikeToken(
    { email: 'diner@example.com', iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com' },
    { expSec: -10 },
  );
  assert.equal(await verifyGoogleIdToken(token, publicKey), null);
});

test('rejects a token signed by a DIFFERENT key (forged/tampered)', async () => {
  const { privateKey: attackerKey } = await generateKeyPair('RS256');
  const forged = await new SignJWT({
    email: 'diner@example.com', email_verified: true,
    iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(attackerKey);
  // Verified against the REAL public key, not the attacker's — must fail.
  assert.equal(await verifyGoogleIdToken(forged, publicKey), null);
});

test('rejects garbage input without throwing', async () => {
  assert.equal(await verifyGoogleIdToken('not-a-jwt', publicKey), null);
  assert.equal(await verifyGoogleIdToken('', publicKey), null);
});

// ── verifyAppleIdToken ────────────────────────────────────────────────────

async function signAppleLikeToken(claims: Record<string, unknown>, opts: { expSec?: number } = {}) {
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(opts.expSec ? Math.floor(Date.now() / 1000) + opts.expSec : '1h')
    .sign(privateKey);
}

test('accepts a validly signed, correctly audienced, verified-email Apple token', async () => {
  const token = await signAppleLikeToken({
    email: 'Diner@Example.com',
    iss: 'https://appleid.apple.com',
    aud: 'com.meetmymenu.app.web',
  });
  const result = await verifyAppleIdToken(token, publicKey);
  assert.deepEqual(result, { email: 'diner@example.com' }, 'email is lowercased/trimmed');
});

test('accepts Apple sending email_verified as the string "true"', async () => {
  const token = await signAppleLikeToken({
    email: 'diner@example.com',
    email_verified: 'true',
    iss: 'https://appleid.apple.com',
    aud: 'com.meetmymenu.app.web',
  });
  assert.deepEqual(await verifyAppleIdToken(token, publicKey), { email: 'diner@example.com' });
});

test('rejects Apple sending email_verified as the string "false"', async () => {
  const token = await signAppleLikeToken({
    email: 'diner@example.com',
    email_verified: 'false',
    iss: 'https://appleid.apple.com',
    aud: 'com.meetmymenu.app.web',
  });
  assert.equal(await verifyAppleIdToken(token, publicKey), null);
});

test('rejects an Apple token for the wrong audience (a different app)', async () => {
  const token = await signAppleLikeToken({
    email: 'diner@example.com',
    iss: 'https://appleid.apple.com',
    aud: 'com.someone-else.app',
  });
  assert.equal(await verifyAppleIdToken(token, publicKey), null);
});

test('rejects an Apple token from the wrong issuer', async () => {
  const token = await signAppleLikeToken({
    email: 'diner@example.com',
    iss: 'https://not-apple.example.com',
    aud: 'com.meetmymenu.app.web',
  });
  assert.equal(await verifyAppleIdToken(token, publicKey), null);
});

test('rejects an Apple token signed by a DIFFERENT key (forged/tampered)', async () => {
  const { privateKey: attackerKey } = await generateKeyPair('RS256');
  const forged = await new SignJWT({
    email: 'diner@example.com', email_verified: true,
    iss: 'https://appleid.apple.com', aud: 'com.meetmymenu.app.web',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(attackerKey);
  assert.equal(await verifyAppleIdToken(forged, publicKey), null);
});

test('rejects garbage input to verifyAppleIdToken without throwing', async () => {
  assert.equal(await verifyAppleIdToken('not-a-jwt', publicKey), null);
  assert.equal(await verifyAppleIdToken('', publicKey), null);
});

// ── Meet My Menu AI's own session tokens ──────────────────────────────────────

test('a session token round-trips to the email it was created for', async () => {
  const token = await createSessionToken('Guest@Example.com');
  const result = await verifySessionToken(token);
  assert.deepEqual(result, { email: 'guest@example.com' });
});

test('a session token is rejected once tampered with', async () => {
  const token = await createSessionToken('guest@example.com');
  const tampered = token.slice(0, -4) + 'abcd';
  assert.equal(await verifySessionToken(tampered), null);
});

test('a session token cannot be forged without the server secret', async () => {
  // An attacker who doesn't know SESSION_SECRET cannot mint a valid token for
  // an arbitrary email — this is the actual property closing bug #20.
  const forged = await new SignJWT({ email: 'victim@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('menuvoice-sync')
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode('a-completely-different-guessed-secret'));
  assert.equal(await verifySessionToken(forged), null);
});

test('an expired session token is rejected', async () => {
  const token = await new SignJWT({ email: 'guest@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('menuvoice-sync')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  assert.equal(await verifySessionToken(token), null);
});

test('garbage session tokens are rejected without throwing', async () => {
  assert.equal(await verifySessionToken('not-a-jwt'), null);
  assert.equal(await verifySessionToken(''), null);
});

// ── bearerToken ──────────────────────────────────────────────────────────

test('bearerToken extracts the token from a well-formed header', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer abc.def.ghi'), 'abc.def.ghi', 'case-insensitive scheme');
});

test('bearerToken returns null for a missing or malformed header', () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(''), null);
  assert.equal(bearerToken('abc.def.ghi'), null, 'missing Bearer prefix');
  assert.equal(bearerToken(['Bearer abc', 'Bearer def']), 'abc', 'takes the first header value');
});
