// In-app tutorial. A genuine ordered sequence (numbered steps are meaningful
// here, not decorative), each step a heading so a screen-reader user can jump
// step to step with the rotor. App TTS stays reserved for Conversation Mode;
// elsewhere VoiceOver reads the semantic headings and text.

import { useEffect, useRef } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { track } from '../lib/telemetry';

interface Step {
  title: string;
  body: string;
}

// First-run tutorial: three short steps, one sentence each, covering only
// what a new user needs before their first menu — how to get it, how to
// interact with it, and the one safety reminder that matters most. Pause
// Voice, appearance settings, and everything else lives in the fuller "How
// Meet My Menu AI works" screen (STEPS below), reachable anytime from Settings.
const FIRST_RUN_STEPS: Step[] = [
  {
    title: 'Open a menu',
    body: 'Scanning your own copy is usually the most accurate — you can also search online or open a saved menu.',
  },
  {
    title: 'Ask a question',
    body: 'Talk with Meet My Menu AI by voice, or switch to Browse Menu to read silently with your screen reader.',
  },
  {
    title: 'Check with staff',
    body: 'Add your allergies in Settings — risky dishes get a warning before anything else, and you should always confirm with staff.',
  },
];

const STEPS: Step[] = [
  {
    title: 'Open a menu',
    body: 'Scanning your own copy is usually the most accurate. You can also search for one online or open a saved menu. Demo Menu is for practice.',
  },
  {
    title: 'Ask a question',
    body: 'When a menu opens, the mic is on. Ask anything, like "What is in the carbonara?" Tap the big button to talk.',
  },
  {
    title: 'Check with staff',
    body: 'Browse Menu is silent. Read category by category with your screen reader.',
  },
  {
    title: 'Allergy alerts',
    body: 'Add allergies in Settings. Risky dishes get an alert, read first. Nothing is hidden. Always confirm with staff.',
  },
  {
    title: 'Pause anytime',
    body: 'Pause Voice stops all talking and listening. Resume Voice picks up where you left off.',
  },
  {
    title: 'Make it comfortable',
    body: 'Set text size, color scheme, and talking speed in Settings.',
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

  const steps = (firstRun ? FIRST_RUN_STEPS : STEPS).slice(0, 3);
  const shortDirections = [
    'Scan it, search for it, or open a saved menu.',
    'Ask about dishes or allergies.',
    'Always confirm ingredients.',
  ];

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
              <p className="tutorial-step__text">{shortDirections[i]}</p>
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
