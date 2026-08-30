// Server-side identity verification for cloud sync. Kept outside api/ so it
// is shared implementation, not a separate Vercel Function.

import { jwtVerify, SignJWT, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { CryptoKey, KeyObject, JWK } from 'jose';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export interface VerifiedIdentity {
  email: string;
}

export async function verifyGoogleIdToken(
  idToken: string,
  getKey: JWTVerifyGetKey | CryptoKey | KeyObject | JWK | Uint8Array = GOOGLE_JWKS,
): Promise<VerifiedIdentity | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !idToken) return null;
  try {
    const { payload } = await jwtVerify(idToken, getKey as JWTVerifyGetKey, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    });
    if (payload.email_verified !== true) return null;
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email ? { email } : null;
  } catch {
    return null;
  }
}

// Apple sends email_verified as the string "true"/"false" on some token
// versions and a real boolean on others — accept either.
function appleEmailVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

export async function verifyAppleIdToken(
  idToken: string,
  getKey: JWTVerifyGetKey | CryptoKey | KeyObject | JWK | Uint8Array = APPLE_JWKS,
): Promise<VerifiedIdentity | null> {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId || !idToken) return null;
  try {
    const { payload } = await jwtVerify(idToken, getKey as JWTVerifyGetKey, {
      issuer: APPLE_ISSUER,
      audience: clientId,
    });
    if (!appleEmailVerified(payload.email_verified)) return null;
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email ? { email } : null;
  } catch {
    return null;
  }
}

const SESSION_ISSUER = 'menuvoice-sync';
const SESSION_TTL = '30d';

function sessionSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(email: string): Promise<string> {
  return new SignJWT({ email: email.trim().toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(sessionSecretKey());
}

export async function verifySessionToken(token: string): Promise<VerifiedIdentity | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecretKey(), { issuer: SESSION_ISSUER });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email ? { email } : null;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}
