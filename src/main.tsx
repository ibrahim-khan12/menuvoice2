import React from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import './index.css';
import App from './App';
import { unlockAudio } from './lib/speech';
import { initTelemetry } from './lib/telemetry';

initTelemetry();

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

// Unlock audio on the very first user gesture, anywhere in the app. iOS/Safari
// (and Chrome's autoplay policy) block all programmatic audio — TTS, earcons,
// SpeechSynthesis — until the first one runs inside a real gesture. Doing it
// once globally means every later timer/callback-driven cue is allowed to play.
function primeAudioOnce() {
  unlockAudio();
  window.removeEventListener('pointerdown', primeAudioOnce);
  window.removeEventListener('touchstart', primeAudioOnce);
  window.removeEventListener('keydown', primeAudioOnce);
}
window.addEventListener('pointerdown', primeAudioOnce, { capture: true });
window.addEventListener('touchstart', primeAudioOnce, { capture: true });
window.addEventListener('keydown', primeAudioOnce, { capture: true });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {googleClientId ? (
      <GoogleOAuthProvider clientId={googleClientId}>
        <App />
      </GoogleOAuthProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
