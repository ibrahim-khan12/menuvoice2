// Login. Remembers the user's email in localStorage so blind users never have
// to type it twice. This screen never speaks — instructions are visible text
// and feedback goes through the role="status" live region, so VoiceOver is the
// only voice here. App TTS is reserved for Conversation Mode.

import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Screen, Title, Heading, Body, PrimaryButton } from '../components';
import { useProfile } from '../state/ProfileContext';
import { restoreFromCloud, isDifferentUser, clearLocalUserData, establishSyncSession } from '../lib/storage';
import { track } from '../lib/telemetry';
import { isNativePlatform, signInWithGoogleNative } from '../lib/nativeGoogleAuth';
import { signInWithAppleNative } from '../lib/nativeAppleAuth';
import { signInWithAppleWeb } from '../lib/appleAuthWeb';

interface GoogleJwt {
  email: string;
  name?: string;
}

interface AppleJwt {
  email: string;
  is_private_email?: boolean;
}

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const googleAvailable = !!googleClientId;
const appleClientId = import.meta.env.VITE_APPLE_CLIENT_ID as string | undefined;
const appleAvailable = !!appleClientId;

export default function LoginScreen() {
  const { profile, update } = useProfile();
  const [email, setEmail] = useState(profile.email ?? '');
  const [showEmail, setShowEmail] = useState(!googleAvailable && !appleAvailable);
  const [srStatus, setSrStatus] = useState('');

  const announce = (msg: string) => { setSrStatus(msg); };

  const loginWithEmail = async (emailToUse: string, name?: string, method: 'email' | 'google' | 'apple' = 'email') => {
    const trimmed = emailToUse.trim();
    if (!trimmed) {
      announce('Please enter your email address first.');
      return;
    }
    // Signing in as a different account: drop the previous user's local saves
    // first, so if this user has no cloud copy they start clean rather than
    // inheriting someone else's saved restaurants.
    if (await isDifferentUser(trimmed)) clearLocalUserData();
    const restored = await restoreFromCloud(trimmed);
    const base = restored ?? { email: trimmed };
    await update(name ? { ...base, name } : base);
    track('auth', 'login', {
      outcome: 'success',
      metadata: { method, cloud_restore_hit: !!restored },
    });
  };

  const handleGoogleIdToken = async (idToken: string) => {
    try {
      const decoded = jwtDecode<GoogleJwt>(idToken);
      announce(`Welcome, ${decoded.name ?? decoded.email}. Signing you in.`);
      // Exchange for a verified sync session BEFORE loading cloud data, so
      // this first load can actually use it. The server-verified email is the
      // authoritative identity for sync; if the exchange fails (offline, or
      // the server isn't configured for it yet) sign-in still proceeds
      // locally with the client-decoded email — cloud sync just stays
      // unavailable until a later successful Google sign-in.
      const verifiedEmail = await establishSyncSession(idToken);
      await loginWithEmail(verifiedEmail ?? decoded.email, decoded.name, 'google');
    } catch {
      announce('Google sign-in failed. Please enter your email instead.');
      track('auth', 'login', { outcome: 'failure', metadata: { method: 'google' } });
      setShowEmail(true);
    }
  };

  const handleGoogleSuccess = async (credentialResponse: { credential?: string }) => {
    if (!credentialResponse.credential) return;
    await handleGoogleIdToken(credentialResponse.credential);
  };

  const handleGoogleError = () => {
    announce('Google sign-in failed. Please enter your email instead.');
    track('auth', 'login', { outcome: 'failure', metadata: { method: 'google' } });
    setShowEmail(true);
  };

  const handleNativeGoogleLogin = async () => {
    if (!googleClientId) return;
    announce('Opening Google sign-in.');
    const idToken = await signInWithGoogleNative(googleClientId);
    if (!idToken) {
      announce('Google sign-in was cancelled.');
      return;
    }
    await handleGoogleIdToken(idToken);
  };

  const handleAppleIdToken = async (idToken: string) => {
    try {
      const decoded = jwtDecode<AppleJwt>(idToken);
      announce('Welcome. Signing you in with Apple.');
      // Same reasoning as the Google path: exchange for a verified sync
      // session before loading cloud data so the first load can use it.
      const verifiedEmail = await establishSyncSession(idToken, 'apple');
      await loginWithEmail(verifiedEmail ?? decoded.email, undefined, 'apple');
    } catch {
      announce('Apple sign-in failed. Please enter your email instead.');
      track('auth', 'login', { outcome: 'failure', metadata: { method: 'apple' } });
      setShowEmail(true);
    }
  };

  const handleAppleLogin = async () => {
    if (!appleClientId) return;
    announce('Opening Apple sign-in.');
    const idToken = isNativePlatform
      ? await signInWithAppleNative(appleClientId)
      : await signInWithAppleWeb(appleClientId);
    if (!idToken) {
      announce('Apple sign-in was cancelled.');
      return;
    }
    await handleAppleIdToken(idToken);
  };

  return (
    <Screen>
      <Title>Meet My Menu AI</Title>
      <Heading>Login</Heading>

      {/* ── Google / Apple Sign-In ─────────────────────────────── */}
      {(googleAvailable || appleAvailable) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'stretch' }}>
          {googleAvailable && (
            isNativePlatform ? (
              <button
                className="btn btn-google"
                type="button"
                onClick={handleNativeGoogleLogin}
                aria-label="Sign in with Google. Opens Google sign-in in your browser"
              >
                <svg className="google-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path fill="#4285F4" d="M21.35 12.23c0-.72-.06-1.25-.19-1.8H12v3.47h5.38c-.11.86-.72 2.15-2.08 3.02l-.02.12 3.02 2.34.21.02c1.93-1.77 3.04-4.39 3.04-7.17Z" />
                  <path fill="#34A853" d="M12 21.75c2.63 0 4.84-.87 6.45-2.35l-3.07-2.38c-.82.57-1.92.97-3.38.97a5.86 5.86 0 0 1-5.53-4.04l-.11.01-3.14 2.43-.04.11A9.75 9.75 0 0 0 12 21.75Z" />
                  <path fill="#FBBC05" d="M6.47 13.95A5.91 5.91 0 0 1 6.16 12c0-.68.12-1.34.3-1.95v-.13L3.29 7.46l-.11.05A9.75 9.75 0 0 0 2.25 12c0 1.61.39 3.14.93 4.49l3.29-2.54Z" />
                  <path fill="#EA4335" d="M12 6.01c1.85 0 3.1.8 3.82 1.47l2.79-2.72C16.83 3.15 14.63 2.25 12 2.25a9.75 9.75 0 0 0-8.82 5.26l3.29 2.54A5.86 5.86 0 0 1 12 6.01Z" />
                </svg>
                <span>Sign in with Google</span>
              </button>
            ) : (
              <GoogleLogin
                onSuccess={handleGoogleSuccess}
                onError={handleGoogleError}
                useOneTap={false}
                text="signin_with"
                shape="rectangular"
                size="large"
                width="100%"
              />
            )
          )}
          {appleAvailable && (
            <button
              className="btn btn-apple"
              type="button"
              onClick={handleAppleLogin}
              aria-label="Sign in with Apple"
            >
              <svg className="apple-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="#fff" d="M16.365 1.43c0 1.14-.462 2.15-1.217 2.9-.83.826-2.02 1.44-3.06 1.35-.135-1.09.428-2.24 1.19-2.98.83-.82 2.24-1.42 3.087-1.27ZM20.94 17.06c-.53 1.22-1.17 2.4-2.06 3.5-.94 1.17-1.9 2.34-3.42 2.36-1.48.03-1.96-.89-3.65-.89-1.7 0-2.23.87-3.63.92-1.47.05-2.58-1.26-3.53-2.42-1.94-2.37-3.43-6.7-1.43-9.63.99-1.45 2.75-2.37 4.66-2.4 1.44-.03 2.79.97 3.66.97.87 0 2.52-1.2 4.24-1.02.72.03 2.75.29 4.05 2.18-.1.07-2.42 1.41-2.39 4.2.03 3.34 2.93 4.45 2.96 4.46-.03.09-.46 1.58-1.51 3.13Z" />
              </svg>
              <span>Sign in with Apple</span>
            </button>
          )}
          {!showEmail && (
            <button
              className="btn-ghost"
              onClick={() => {
                setShowEmail(true);
                announce('You can now enter your email address manually.');
              }}
              aria-label="Sign in with email instead"
            >
              Use email
            </button>
          )}
        </div>
      )}

      {/* ── Email fallback ─────────────────────────────── */}
      {showEmail && (
        <>
          {profile.email && <Body>Saved email: {profile.email}.</Body>}

          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            aria-label="Email address"
            autoComplete="email"
            onKeyDown={(e) => { if (e.key === 'Enter') loginWithEmail(email); }}
          />

          <PrimaryButton
            label="Login"
            onClick={() => loginWithEmail(email)}
            hint="Continue with this email"
          />
        </>
      )}
      <p role="status" aria-live="polite" className="body" style={{ minHeight: 24, margin: 0, textAlign: 'center' }}>
        {srStatus}
      </p>
    </Screen>
  );
}
