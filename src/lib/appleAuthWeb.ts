// Sign in with Apple on the web (not the Capacitor native app — see
// nativeAppleAuth.ts for that). Apple's own JS SDK handles the popup and
// form_post exchange internally and hands back the ID token directly, so
// this doesn't need the server relay the native flow uses.
const SDK_URL = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const REDIRECT_URI = 'https://app.meetmymenu.com/api/sync?action=apple-callback';

interface AppleAuthSuccess {
  authorization: { id_token: string; code?: string; state?: string };
  user?: { name?: { firstName?: string; lastName?: string }; email?: string };
}

interface AppleIdNamespace {
  auth: {
    init(config: {
      clientId: string;
      scope: string;
      redirectURI: string;
      usePopup: boolean;
      nonce?: string;
    }): void;
    signIn(): Promise<AppleAuthSuccess>;
  };
}

declare global {
  interface Window {
    AppleID?: AppleIdNamespace;
  }
}

let sdkLoad: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.AppleID) return Promise.resolve();
  if (sdkLoad) return sdkLoad;
  sdkLoad = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Sign in with Apple.'));
    document.head.appendChild(script);
  });
  return sdkLoad;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens Apple's sign-in popup and resolves with the ID token, or null if the
 * user cancels. Nonce is verified the same way the native flow verifies its
 * custom-scheme callback, for a consistent replay-protection story.
 */
export async function signInWithAppleWeb(clientId: string): Promise<string | null> {
  await loadSdk();
  if (!window.AppleID) return null;
  const nonce = randomNonce();
  window.AppleID.auth.init({
    clientId,
    scope: 'name email',
    redirectURI: REDIRECT_URI,
    usePopup: true,
    nonce,
  });
  try {
    const result = await window.AppleID.auth.signIn();
    return result.authorization?.id_token ?? null;
  } catch {
    return null;
  }
}
