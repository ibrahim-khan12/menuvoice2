import { useState, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ProfileProvider, useProfile } from './state/ProfileContext';
import { PauseProvider, usePause } from './state/PauseContext';
import { Route, Navigate } from './nav';
import { track, setCurrentScreen } from './lib/telemetry';
import {
  createAppHistoryEntry,
  readAppHistoryEntry,
  type AppHistoryEntry,
  type StoredAppHistoryEntry,
} from './lib/appHistory';

import LoginScreen from './screens/LoginScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import HomeScreen from './screens/HomeScreen';
import GetMenuScreen from './screens/GetMenuScreen';
import CaptureScreen from './screens/CaptureScreen';
import ConversationScreen from './screens/ConversationScreen';
import SavedScreen from './screens/SavedScreen';
import SettingsScreen from './screens/SettingsScreen';
import FindScreen from './screens/FindScreen';
import TutorialScreen from './screens/TutorialScreen';

function Root() {
  const { profile, loaded, update } = useProfile();
  const { paused, status, pause, resume } = usePause();
  const [historyEntry, setHistoryEntry] = useState<AppHistoryEntry>(initializeAppHistory);
  const historyEntryRef = useRef(historyEntry);
  const routesByPositionRef = useRef(new Map<number, Route>([[historyEntry.position, historyEntry.route]]));
  const prevScreenRef = useRef<string>('');
  const screenEnterRef = useRef<number>(Date.now());

  const showHistoryEntry = useCallback((entry: AppHistoryEntry) => {
    historyEntryRef.current = entry;
    routesByPositionRef.current.set(entry.position, entry.route);
    setHistoryEntry(entry);
  }, []);

  const navigate: Navigate = useCallback((route) => {
    const current = historyEntryRef.current;

    // Returning home has always reset Meet My Menu AI's internal stack. Traverse to
    // the root browser entry too, so a later VoiceOver scrub cannot reopen the
    // completed conversation or capture flow.
    if (route.name === 'home') {
      if (current.position > 0) window.history.go(-current.position);
      return;
    }

    const next = createAppHistoryEntry(route, current.position + 1);
    for (const position of routesByPositionRef.current.keys()) {
      if (position > next.position) routesByPositionRef.current.delete(position);
    }

    pushAppHistoryEntry(next);
    showHistoryEntry(next);
  }, [showHistoryEntry]);

  const goBack = useCallback(() => {
    if (historyEntryRef.current.position > 0) window.history.back();
  }, []);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const stored = readAppHistoryEntry(event.state);
      if (!stored) return;

      const route = stored.route ?? routesByPositionRef.current.get(stored.position);
      if (!route) return;

      showHistoryEntry({ ...stored, route });
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [showHistoryEntry]);

  useEffect(() => {
    const name = historyEntry.route.name;
    const prev = prevScreenRef.current;
    if (prev && prev !== name) {
      track('nav', 'screen_exit', {
        screen: prev,
        durationMs: Date.now() - screenEnterRef.current,
      });
    }
    setCurrentScreen(name);
    track('nav', 'screen_enter', { screen: name });
    screenEnterRef.current = Date.now();
    prevScreenRef.current = name;
  }, [historyEntry]);

  if (!loaded) {
    return (
      <div className="screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p className="body" role="status">Loading Meet My Menu AI...</p>
      </div>
    );
  }

  if (!profile.email) return <LoginScreen />;
  if (!profile.onboarded) return <OnboardingScreen />;

  // First open after setup: the tutorial IS the first screen. "Get started"
  // (or navigating anywhere from it) marks it seen; it never auto-shows again.
  if (!profile.tutorialSeen) {
    return (
      <TutorialScreen
        firstRun
        navigate={(route) => {
          update({ tutorialSeen: true });
          navigate(route);
        }}
        goBack={() => update({ tutorialSeen: true })}
      />
    );
  }

  const current = historyEntry.route;
  let screen: ReactNode;
  switch (current.name) {
    case 'home':
      screen = <HomeScreen navigate={navigate} goBack={goBack} />;
      break;
    case 'getMenu':
      screen = <GetMenuScreen navigate={navigate} goBack={goBack} />;
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
    case 'tutorial':
      screen = <TutorialScreen navigate={navigate} goBack={goBack} />;
      break;
    default:
      screen = <HomeScreen navigate={navigate} goBack={goBack} />;
  }

  // Pause Voice stops Meet My Menu AI speech and the microphone — the only screen
  // where either is running is Conversation, so the control only makes sense
  // there. It used to float on every screen; showing it on Login, Onboarding,
  // Home, Capture, Find, Saved, Settings, and Tutorial offered a control with
  // nothing to do on any of them.
  const showPauseVoice = current.name === 'conversation';

  const page = (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0 }}
      >
        {status}
      </div>
      {showPauseVoice && (
        <button
          className="btn btn-secondary voice-toggle"
          onClick={() => (paused ? resume() : pause())}
          aria-pressed={paused}
          aria-label={
            paused
              ? 'Resume voice and microphone.'
              : 'Pause voice and microphone.'
          }
        >
          <span className="voice-toggle__glyph" aria-hidden="true">
            {paused ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5.5v13l11-6.5-11-6.5z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
                <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
              </svg>
            )}
          </span>
          {paused ? 'Resume Voice & Mic' : 'Pause Voice & Mic'}
        </button>
      )}
      {current.name !== 'settings' && (
        <button
          className="app-settings-button"
          onClick={() => navigate({ name: 'settings' })}
          aria-label="Settings. Change text size, colors, allergies, and preferences."
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
            <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Settings</span>
        </button>
      )}
      {screen}
    </>
  );

  if (historyEntry.position === 0) return page;

  return (
    <BackNavigationDialog
      key={historyEntry.position}
      label={pageStatusFor(current.name)}
      onDismiss={goBack}
    >
      {page}
    </BackNavigationDialog>
  );
}

function BackNavigationDialog({
  children,
  label,
  onDismiss,
}: {
  children: ReactNode;
  label: string;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dismissingRef = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }

    // showModal() normally focuses the first button, which is the global Pause
    // Voice control. Put focus on the route landmark in the same layout pass so
    // VoiceOver hears the new screen instead of queueing that unrelated button.
    dialog.querySelector<HTMLElement>('main.screen')?.focus();
  }, []);

  const dismiss = (source: 'dialog_cancel' | 'dialog_close') => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    track('nav', 'back_gesture', { metadata: { source } });
    onDismiss();
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-route-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onCancel={(event) => {
        // A VoiceOver two-finger scrub dismisses a modal dialog through this
        // native path on iOS. Keep the dialog mounted until browser history has
        // moved so the previous Meet My Menu AI screen is restored atomically.
        event.preventDefault();
        dismiss('dialog_cancel');
      }}
      onClose={() => {
        // WebKit normally fires `cancel` first. This covers versions that close
        // the dialog directly for an accessibility dismiss action.
        dismiss('dialog_close');
      }}
    >
      {children}
    </dialog>
  );
}

function initializeAppHistory(): AppHistoryEntry {
  const stored = readAppHistoryEntry(window.history.state);
  if (stored?.route) return { ...stored, route: stored.route };

  const initial = createAppHistoryEntry({ name: 'home' }, 0);
  window.history.replaceState(initial, '');
  return initial;
}

function pushAppHistoryEntry(entry: AppHistoryEntry): void {
  try {
    window.history.pushState(entry, '');
  } catch {
    // A very large parsed menu can exceed a browser's history-state quota.
    // Keep the route in memory while still adding the Back target VoiceOver
    // needs. Browser Back/Forward continues to work for the current session.
    const compact: StoredAppHistoryEntry = {
      key: entry.key,
      version: entry.version,
      position: entry.position,
    };
    window.history.pushState(compact, '');
  }
}

function pageStatusFor(name: Route['name']): string {
  switch (name) {
    case 'home': return 'Home screen. Choose Read a Menu, Saved Restaurants, or Demo Menu. Settings is available in the top right.';
    case 'getMenu': return 'Read a menu. Choose Scan a Menu or Find a Menu.';
    case 'capture': return 'Capture menu';
    case 'find': return 'Find menu screen. Enter a restaurant name and city, or paste a menu link.';
    case 'conversation': return 'Conversation screen. Meet My Menu AI can speak with you or let you browse the menu.';
    case 'saved': return 'Saved restaurants screen. Open or delete saved menus.';
    case 'settings': return 'Settings screen. Update profile, allergies, voice, and app preferences.';
    case 'tutorial': return 'Tutorial screen. Learn how to use Meet My Menu AI step by step.';
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
