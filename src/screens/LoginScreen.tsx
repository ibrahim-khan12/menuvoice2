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

interface GoogleJwt {
  email: string;
  name?: string;
}

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const googleAvailable = !!googleClientId;

export default function LoginScreen() {
  const { profile, update } = useProfile();
  const [email, setEmail] = useState(profile.email ?? '');
  const [showEmail, setShowEmail] = useState(!googleAvailable);
  const [srStatus, setSrStatus] = useState('');

  const announce = (msg: string) => { setSrStatus(msg); };

  const loginWithEmail = async (emailToUse: string, name?: string, method: 'email' | 'google' = 'email') => {
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

  return (
    <Screen>
      <Title>Meet My Menu AI</Title>
      <Heading>Login</Heading>

      {/* ── Google Sign-In ─────────────────────────────── */}
      {googleAvailable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'stretch' }}>
          {isNativePlatform ? (
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
          )}
          {!showEmail && (
            <button
              className="btn-ghost"
              onClick={() => {
                setShowEmail(true);
                announce('You can now enter your email address manually.');
              }}
              aria-label="Sign in with email instead of Google"
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
