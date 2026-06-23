// Home: three large action buttons, silent on mount.
// VoiceOver reads the buttons — no app TTS, no voice-command mic.

import { Screen, Title, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { DEMO_MENU, DEMO_RESTAURANT_NAME } from '../lib/demoMenu';

export default function HomeScreen({ navigate }: ScreenProps) {

  return (
    <Screen>
      <Title>MenuVoice</Title>
      <div className="col" style={{ marginTop: 24 }}>
        <PrimaryButton
          label="Scan a Menu"
          hint="Use your camera to read a paper menu"
          onClick={() => navigate({ name: 'capture' })}
          style={{ minHeight: 96 }}
        />
        <PrimaryButton
          label="Find a Menu"
          hint="Search by restaurant name or paste a menu link"
          onClick={() => navigate({ name: 'find' })}
          style={{ minHeight: 96 }}
        />
        <SecondaryButton
          label="Saved Restaurants"
          hint="Open a menu you already saved"
          onClick={() => navigate({ name: 'saved' })}
          style={{ minHeight: 96 }}
        />
        <SecondaryButton
          label="Demo Menu"
          hint="Open a preloaded sample menu without using the camera or scan API"
          onClick={() =>
            navigate({
              name: 'conversation',
              menu: DEMO_MENU,
              restaurantName: DEMO_RESTAURANT_NAME,
              source: 'photo',
            })
          }
          style={{ minHeight: 96 }}
        />
      </div>

      <div className="spacer" />

      <SecondaryButton
        label="Demo Menu"
        hint="Open a sample menu without using the camera or search"
        onClick={() =>
          navigate({
            name: 'conversation',
            menu: DEMO_MENU,
            restaurantName: DEMO_RESTAURANT_NAME,
            source: 'photo',
          })
        }
      />

      <SecondaryButton
        label="Settings"
        hint="Change your name, allergies, and voice settings"
        onClick={() => navigate({ name: 'settings' })}
      />
    </Screen>
  );
}
