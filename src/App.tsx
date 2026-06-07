import { useState, useCallback } from 'react';
import { ProfileProvider, useProfile } from './state/ProfileContext';
import { Route, Navigate } from './nav'; // v2

import LoginScreen from './screens/LoginScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import HomeScreen from './screens/HomeScreen';
import CaptureScreen from './screens/CaptureScreen';
import ConversationScreen from './screens/ConversationScreen';
import BrowseScreen from './screens/BrowseScreen';
import SavedScreen from './screens/SavedScreen';
import SettingsScreen from './screens/SettingsScreen';
import UrlScreen from './screens/UrlScreen';

function Root() {
  const { profile, loaded } = useProfile();
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);

  const navigate: Navigate = useCallback((route) => {
    if (route.name === 'home') setStack([{ name: 'home' }]);
    else setStack((s) => [...s, route]);
  }, []);

  const goBack = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  if (!loaded) {
    return (
      <div className="screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p className="body">Loading MenuVoice…</p>
      </div>
    );
  }

  if (!profile.email) return <LoginScreen />;
  if (!profile.onboarded) return <OnboardingScreen />;

  const current = stack[stack.length - 1];
  switch (current.name) {
    case 'home':
      return <HomeScreen navigate={navigate} goBack={goBack} />;
    case 'capture':
      return <CaptureScreen navigate={navigate} goBack={goBack} />;
    case 'url':
      return <UrlScreen navigate={navigate} goBack={goBack} />;
    case 'conversation':
      return <ConversationScreen navigate={navigate} goBack={goBack} route={current} />;
    case 'browse':
      return <BrowseScreen navigate={navigate} goBack={goBack} route={current} />;
    case 'saved':
      return <SavedScreen navigate={navigate} goBack={goBack} />;
    case 'settings':
      return <SettingsScreen navigate={navigate} goBack={goBack} />;
    default:
      return <HomeScreen navigate={navigate} goBack={goBack} />;
  }
}

export default function App() {
  return (
    <ProfileProvider>
      <Root />
      <div
        id="sr-announce"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0 }}
      />
    </ProfileProvider>
  );
}
