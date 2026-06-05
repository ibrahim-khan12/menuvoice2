// First-use setup — VOICE FIRST. The app speaks each question; the guest answers
// by tapping the mic and speaking (Whisper transcribes). Typing is a fallback,
// not the main path. We only ask name + allergies (allergies = safety). Taste
// preferences are NOT interrogated here — they're learned naturally from what
// the guest decides to order over time (see ConversationScreen + profile).

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, Heading, Body, PrimaryButton, SecondaryButton } from '../components';
import { useProfile } from '../state/ProfileContext';
import { speak, stopSpeaking } from '../lib/speech';
import { earconStart, earconStop } from '../lib/earcon';
import { startRecording, stopRecording, requestMicPermission } from '../lib/recorder';
import { transcribeAudio } from '../lib/openai';
import { cleanName, parseList } from '../util';

type Step = 'intro' | 'name' | 'allergies';

const INTRO =
  'Welcome to MenuVoice. I read restaurant menus aloud and talk with you about the food, ' +
  'so you can decide what to order on your own. Two quick questions to set up — just tap the ' +
  'big button and speak your answer. You can change anything later in Settings.';

export default function OnboardingScreen() {
  const { update } = useProfile();
  const [step, setStep] = useState<Step>('intro');
  const [name, setName] = useState('');
  const [allergiesText, setAllergiesText] = useState('');

  const promptFor = (s: Step): string => {
    switch (s) {
      case 'intro':
        return INTRO;
      case 'name':
        return 'First, what should I call you? Tap the button and say your first name.';
      case 'allergies':
        return 'Do you have any food allergies or things you cannot eat? Tap and say them, or say none.';
    }
  };

  // Only speak interactive steps — intro text is on-screen so VoiceOver reads it.
  // Speaking starts only after the user taps "Let's begin", which is the natural
  // handoff point from VoiceOver navigation to app-driven voice.
  const spoken = useRef<Set<Step>>(new Set());
  useEffect(() => {
    if (step === 'intro') return;
    if (!spoken.current.has(step)) {
      spoken.current.add(step);
      speak(promptFor(step));
    }
    return () => stopSpeaking();
  }, [step]);

  const finish = async () => {
    const allergies = parseList(allergiesText);
    await update({ name: cleanName(name), allergies, onboarded: true });
    await speak(
      `Thanks${name.trim() ? ', ' + cleanName(name) : ''}. You're all set. ` +
        (allergies.length
          ? `I'll always warn you about ${allergies.join(' and ')} before describing any dish.`
          : 'You can add allergies any time in Settings.')
    );
  };

  return (
    <Screen>
      <Title>MenuVoice</Title>

      {step === 'intro' && (
        <>
          <Body>{INTRO}</Body>
          <PrimaryButton
            label="Let's begin"
            onClick={() => setStep('name')}
            hint="Starts setup — app will speak from here"
            style={{ minHeight: 96, marginTop: 32 }}
          />
        </>
      )}

      {step === 'name' && (
        <VoiceStep
          question="What should I call you?"
          help="Tap the button and say your first name — or type it below."
          placeholder="First name"
          value={name}
          onChange={setName}
          transform={cleanName}
          onNext={() => setStep('allergies')}
          nextLabel="Next"
        />
      )}

      {step === 'allergies' && (
        <VoiceStep
          question="Any food allergies?"
          help="Tap and say them (e.g. shellfish and peanuts), or say none. You can also type."
          placeholder="e.g. shellfish, peanuts"
          value={allergiesText}
          onChange={setAllergiesText}
          // keep as a readable string; turned into a list at finish
          transform={(raw) => raw.replace(/\band\b/gi, ',').replace(/[.!]+$/, '').trim()}
          onNext={finish}
          nextLabel="Finish"
          onBack={() => setStep('name')}
        />
      )}
    </Screen>
  );
}

type RecState = 'idle' | 'recording' | 'working';

function VoiceStep({
  question,
  help,
  placeholder,
  value,
  onChange,
  transform,
  onNext,
  nextLabel,
  onBack,
}: {
  question: string;
  help: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  transform?: (raw: string) => string;
  onNext: () => void;
  nextLabel: string;
  onBack?: () => void;
}) {
  const [rec, setRec] = useState<RecState>('idle');

  const toggleMic = async () => {
    if (rec === 'idle') {
      const ok = await requestMicPermission();
      if (!ok) {
        speak('I could not access the microphone. You can type your answer instead.');
        return;
      }
      try {
        await startRecording();
        earconStart();
        setRec('recording');
      } catch {
        speak('I could not start the microphone. Please type your answer.');
      }
      return;
    }
    if (rec === 'recording') {
      setRec('working');
      earconStop();
      let blob: Blob | null = null;
      try {
        blob = await stopRecording();
      } catch {
        blob = null;
      }
      if (!blob) {
        setRec('idle');
        return;
      }
      try {
        const raw = await transcribeAudio(blob);
        const v = transform ? transform(raw) : raw.trim();
        onChange(v);
        speak(v ? `I heard: ${v}. Tap ${nextLabel}, or speak again to redo.` : 'I didn’t catch that. Try again, or type it.');
      } catch {
        speak('Sorry, I had trouble hearing that. Try again, or type your answer.');
      }
      setRec('idle');
    }
  };

  const micLabel = rec === 'recording' ? 'Done speaking' : rec === 'working' ? 'One moment…' : 'Tap and speak';

  return (
    <div className="col">
      <Heading>{question}</Heading>
      <Body>{help}</Body>

      <PrimaryButton
        label={micLabel}
        hint="Records your spoken answer"
        onClick={toggleMic}
        disabled={rec === 'working'}
        style={{ minHeight: 96, background: rec === 'recording' ? 'var(--success)' : undefined }}
      />

      <input
        className="input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`${question} — or type here`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onNext();
        }}
      />

      <PrimaryButton label={nextLabel} onClick={onNext} />
      {onBack ? <SecondaryButton label="Back" onClick={onBack} /> : null}
    </div>
  );
}
