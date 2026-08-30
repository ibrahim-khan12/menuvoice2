// Sign in with Apple inside the Capacitor iOS app. Uses the same
// system-browser + custom-URL-scheme pattern as nativeGoogleAuth.ts, so it
// needs no extra native plugin. Apple requires response_mode=form_post
// whenever an id_token is requested — the token is POSTed server-side to
// api/apple-callback.ts, which bounces it into the app's custom scheme.
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { tokenHasNonce } from './googleNonce';

export const isNativePlatform = Capacitor.isNativePlatform();

const REDIRECT_PAGE = 'https://app.meetmymenu.com/api/apple-callback';
const APP_CALLBACK_PREFIX = 'com.meetmymenu.app://apple-oauth-callback';

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens the system browser for Sign in with Apple and resolves with the raw
 * ID token once the app is reopened via its custom URL scheme. Resolves null
 * if the user cancels or Apple reports an error.
 */
export function signInWithAppleNative(clientId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const nonce = randomNonce();

    const finish = (idToken: string | null) => {
      if (settled) return;
      settled = true;
      urlListener.then((h) => h.remove());
      closedListener.then((h) => h.remove());
      Browser.close().catch(() => {});
      resolve(idToken);
    };

    const urlListener = App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
      if (!event.url.startsWith(APP_CALLBACK_PREFIX)) return;
      const fragment = event.url.split('#')[1] ?? '';
      const params = new URLSearchParams(fragment);
      const idToken = params.get('id_token');
      finish(idToken && tokenHasNonce(idToken, nonce) ? idToken : null);
    });

    const closedListener = Browser.addListener('browserFinished', () => finish(null));

    const authUrl = new URL('https://appleid.apple.com/auth/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_PAGE);
    authUrl.searchParams.set('response_type', 'code id_token');
    authUrl.searchParams.set('response_mode', 'form_post');
    authUrl.searchParams.set('scope', 'name email');
    authUrl.searchParams.set('nonce', nonce);

    Browser.open({ url: authUrl.toString(), presentationStyle: 'popover' });
  });
}
