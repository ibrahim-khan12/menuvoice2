import { jwtDecode } from 'jwt-decode';

/** Verify that an ID token belongs to the browser flow this app started. */
export function tokenHasNonce(idToken: string, expectedNonce: string): boolean {
  try {
    return jwtDecode<{ nonce?: unknown }>(idToken).nonce === expectedNonce;
  } catch {
    return false;
  }
}
