// Home: greeting + large action buttons + voice command support.
// No auto-speak on mount — VoiceOver reads the on-screen buttons.
// App voice activates only when the user taps the mic button.

import { Screen, Title, Subtitle, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { useProfile } from '../state/ProfileContext';
import { useVoiceNav } from '../hooks/useVoiceNav';

export default function HomeScreen({ navigate }: ScreenProps) {
  const { profile } = useProfile();
  const name = profile.name ? `, ${profile.name}` : '';

  const { phase, announce, listen, finish } = useVoiceNav({
    voice: profile.ttsVoice,
    commands: [
      { id: 'new',      keywords: ['new', 'scan', 'capture', 'restaurant', 'start', 'menu'] },
      { id: 'saved',    keywords: ['saved', 'previous', 'history', 'old', 'my restaurants'] },
      { id: 'url',      keywords: ['website', 'url', 'link', 'online', 'web', 'internet', 'site'] },
      { id: 'settings', keywords: ['settings', 'setting', 'preferences', 'change', 'voice', 'allerg'] },
    ],
    onCommand: async (id) => {
      if (id === 'new')           navigate({ name: 'capture' });
      else if (id === 'saved')    navigate({ name: 'saved' });
      else if (id === 'url')      navigate({ name: 'url' });
      else if (id === 'settings') navigate({ name: 'settings' });
    },
    onNoMatch: () =>
      'Say "new restaurant" to scan a menu, "website" to use a URL, "saved" for a saved one, or "settings".',
  });

  // No auto-announce — VoiceOver reads the on-screen buttons when the user arrives.
  // App voice only starts when the user taps the mic button.

  const busy = phase === 'announcing' || phase === 'transcribing';
  const micLabel =
    phase === 'recording'    ? 'Done speaking' :
    phase === 'transcribing' ? 'Hearing you…'  :
    phase === 'announcing'   ? 'Please wait…'  :
                               'Tap to speak a command';

  return (
    <Screen>
      <div className="col" style={{ marginTop: 24, gap: 8 }}>
        <Title>Hello{name}.</Title>
        <Subtitle>What would you like to do?</Subtitle>
      </div>

      <div className="col" style={{ marginTop: 32 }}>
        <PrimaryButton
          label="New Restaurant"
          hint="Capture a menu and start a conversation"
          onClick={() => navigate({ name: 'capture' })}
          style={{ minHeight: 96 }}
        />
        <SecondaryButton
          label="My Saved Restaurants"
          hint="Open a menu you captured before"
          onClick={() => navigate({ name: 'saved' })}
          style={{ minHeight: 96 }}
        />
        <SecondaryButton
          label="Menu from Website"
          hint="Paste a restaurant's URL and I'll read the menu"
          onClick={() => navigate({ name: 'url' })}
          style={{ minHeight: 72 }}
        />
      </div>

      <div className="spacer" />

      {/* Voice command button */}
      <PrimaryButton
        label={micLabel}
        hint="Speak a navigation command"
        onClick={phase === 'recording' ? finish : listen}
        disabled={busy}
        style={{
          minHeight: 80,
          background: phase === 'recording' ? 'var(--success)' : undefined,
        }}
      />

      <SecondaryButton label="Settings" onClick={() => navigate({ name: 'settings' })} />
    </Screen>
  );
}
