// In-app tutorial. A genuine ordered sequence (numbered steps are meaningful
// here, not decorative), each step a heading so a screen-reader user can jump
// step to step with the rotor. App TTS stays reserved for Conversation Mode;
// elsewhere VoiceOver reads the semantic headings and text.

import { useEffect, useRef } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { track } from '../lib/telemetry';

export interface Step {
  title: string;
  body: string;
}

// First-run tutorial: the few things a new user needs before their first menu.
// Every line is short and plain — this is read aloud by a screen reader, and a
// long sentence is one the listener is still hearing after they have moved on.
//
// The "Read menu" step is here because taking photos does NOT start the
// reading. Nothing happens until that button is activated, and a blind user
// who does not know that is left holding a phone full of photos wondering why
// the app has gone quiet.
export const FIRST_RUN_STEPS: Step[] = [
  {
    title: 'Get the menu',
    body: 'Scan it with your camera, search online, or open a saved one.',
  },
  {
    title: 'Then tap Read menu',
    body: 'Photos are not read until you tap Read menu. With Voice Control, say "Tap Read menu."',
  },
  {
    title: 'Talk or browse',
    body: 'Talk with me, or switch to Browse Menu and read with your screen reader.',
  },
  {
    title: 'Allergy safety',
    body: 'Add allergies in Settings. Risky dishes get a warning first. Always check with staff.',
  },
];

export const STEPS: Step[] = [
  {
    title: 'Get a menu',
    body: 'Scan it with your camera, search online, or open a saved one. Demo Menu is for practice.',
  },
  {
    title: 'Take your photos',
    body: 'I take them for you when the menu is lined up. You can also tap Take photo.',
  },
  {
    title: 'Then tap Read menu',
    body: 'Photos are not read until you tap Read menu. With Voice Control, say "Tap Read menu."',
  },
  {
    title: 'Talk with me',
    body: 'When a menu opens, the mic is on. Ask things like "What is in the carbonara?"',
  },
  {
    title: 'Browse quietly',
    body: 'Browse Menu is silent. Read it with your screen reader.',
  },
  {
    title: 'Allergy alerts',
    body: 'Add allergies in Settings. Risky dishes get an alert first. Always check with staff.',
  },
  {
    title: 'Pause anytime',
    body: 'Pause Voice stops all talking and listening. Resume Voice brings it back.',
  },
  {
    title: 'Make it comfortable',
    body: 'Set text size, colors, and talking speed in Settings.',
  },
];

export default function TutorialScreen({
  navigate,
  goBack,
  firstRun,
}: ScreenProps & { firstRun?: boolean }) {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      track('tutorial', 'open', { metadata: { firstRun: !!firstRun } });
    }
  }, [firstRun]);

  const steps = firstRun ? FIRST_RUN_STEPS : STEPS;

  return (
    <Screen>
      <Title>{firstRun ? 'Welcome to Meet My Menu AI' : 'How Meet My Menu AI works'}</Title>
      <Body>{steps.length} quick step{steps.length === 1 ? '' : 's'}.</Body>

      <ol className="tutorial-list">
        {steps.map((step, i) => (
          <li key={step.title} className="tutorial-step">
            <span className="tutorial-step__num" aria-hidden="true">{i + 1}</span>
            <div className="tutorial-step__body">
              <h2 className="tutorial-step__title">{step.title}</h2>
              <p className="tutorial-step__text">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {firstRun ? (
        <>
          <PrimaryButton
            label="Get started"
            hint="Go to the home screen"
            onClick={goBack}
          />
          <SecondaryButton
            label="Try the Demo Menu"
            hint="Open a sample menu to practice, no camera needed"
            onClick={() => {
              import('../lib/demoMenu').then(({ DEMO_MENU, DEMO_RESTAURANT_NAME }) => {
                navigate({ name: 'conversation', menu: DEMO_MENU, restaurantName: DEMO_RESTAURANT_NAME, source: 'photo' });
              });
            }}
          />
        </>
      ) : (
        <>
          <PrimaryButton
            label="Try the Demo Menu"
            hint="Open a sample menu to practice, no camera needed"
            onClick={() => {
              import('../lib/demoMenu').then(({ DEMO_MENU, DEMO_RESTAURANT_NAME }) => {
                navigate({ name: 'conversation', menu: DEMO_MENU, restaurantName: DEMO_RESTAURANT_NAME, source: 'photo' });
              });
            }}
          />
          <SecondaryButton label="Back" hint="Return to the previous screen" onClick={goBack} />
        </>
      )}
    </Screen>
  );
}
