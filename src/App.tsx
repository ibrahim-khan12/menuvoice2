import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ProfileProvider, useProfile } from './state/ProfileContext';
import { PauseProvider, usePause } from './state/PauseContext';
import { Route, Navigate } from './nav';
import { track, setCurrentScreen } from './lib/telemetry';

import LoginScreen from './screens/LoginScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import HomeScreen from './screens/HomeScreen';
import CaptureScreen from './screens/CaptureScreen';
import ConversationScreen from './screens/ConversationScreen';
import SavedScreen from './screens/SavedScreen';
import SettingsScreen from './screens/SettingsScreen';
import FindScreen from './screens/FindScreen';

function Root() {
  const { profile, loaded } = useProfile();
  const { paused, status, pause, resume } = usePause();
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const [pageStatus, setPageStatus] = useState('');
  const prevScreenRef = useRef<string>('');
  const screenEnterRef = useRef<number>(Date.now());

  const navigate: Navigate = useCallback((route) => {
    if (route.name === 'home') setStack([{ name: 'home' }]);
    else setStack((s) => [...s, route]);
  }, []);

  const goBack = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  useEffect(() => {
    const name = stack[stack.length - 1].name;
    const prev = prevScreenRef.current;
    if (prev && prev !== name) {
      track('nav', 'screen_exit', {
        screen: prev,
        durationMs: Date.now() - screenEnterRef.current,
      });
    }
    setCurrentScreen(name);
    track('nav', 'screen_enter', { screen: name });
    setPageStatus(pageStatusFor(name));
    screenEnterRef.current = Date.now();
    prevScreenRef.current = name;
  }, [stack]);

  if (!loaded) {
    return (
      <div className="screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p className="body" role="status">Loading MenuVoice...</p>
      </div>
    );
  }

  if (!profile.email) return <LoginScreen />;
  if (!profile.onboarded) return <OnboardingScreen />;

  const current = stack[stack.length - 1];
  let screen: ReactNode;
  switch (current.name) {
    case 'home':
      screen = <HomeScreen navigate={navigate} goBack={goBack} />;
      break;
    case 'capture':
      screen = <CaptureScreen navigate={navigate} goBack={goBack} route={current} />;
      break;
    case 'find':
      screen = <FindScreen navigate={navigate} goBack={goBack} />;
      break;
    case 'conversation':
      screen = <ConversationScreen navigate={navigate} goBack={goBack} route={current} />;
      break;
    case 'saved':
      screen = <SavedScreen navigate={navigate} goBack={goBack} />;
      break;
    case 'settings':
      screen = <SettingsScreen navigate={navigate} goBack={goBack} />;
      break;
    default:
      screen = <HomeScreen navigate={navigate} goBack={goBack} />;
  }

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0 }}
      >
        {[pageStatus, status].filter(Boolean).join(' ')}
      </div>
      <button
        className="btn btn-secondary"
        onClick={() => (paused ? resume() : pause())}
        aria-pressed={paused}
        aria-label={paused ? 'Resume MenuVoice speech and listening' : 'Pause MenuVoice speech and listening'}
        style={{
          position: 'fixed',
          right: 12,
          bottom: 12,
          zIndex: 20,
          width: 'auto',
          minHeight: 56,
          padding: '10px 16px',
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
      {screen}
    </>
  );
}

function pageStatusFor(name: Route['name']): string {
  switch (name) {
    case 'home': return 'Home screen. Choose scan, find, demo menu, saved restaurants, or settings.';
    case 'capture': return 'Capture menu screen. Point the camera at the menu, take photos, then analyze.';
    case 'find': return 'Find menu screen. Enter a restaurant name and city, or paste a menu link.';
    case 'conversation': return 'Conversation screen. MenuVoice can speak with you or let you browse the menu.';
    case 'saved': return 'Saved restaurants screen. Open or delete saved menus.';
    case 'settings': return 'Settings screen. Update profile, allergies, voice, and app preferences.';
  }
}

export default function App() {
  return (
    <ProfileProvider>
      <PauseProvider>
        <Root />
      </PauseProvider>
    </ProfileProvider>
  );
}
