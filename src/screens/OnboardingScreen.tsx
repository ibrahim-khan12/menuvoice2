// First-use setup — type-only and silent. Voice input on name/allergies was
// unreliable (mishearing, misspelling) for two fields where accuracy matters
// most, so setup goes straight to a typed question, no separate welcome/start
// screen and no mic step. This screen never speaks either: the question text
// is visible and the focused heading gives VoiceOver the prompt. App TTS is
// reserved for Conversation Mode.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton, AllergenReviewPanel, type AllergenQuestion } from '../components';
import { useProfile } from '../state/ProfileContext';
import { cleanName, parseList, reviewAllergenInput, removeFromList } from '../util';
import { configuredAppleShortcutUrl, isAppleMobileDevice } from '../lib/appleShortcut';
import { track } from '../lib/telemetry';

type Step = 'voiceover' | 'name' | 'allergyChoice' | 'allergies' | 'confirm' | 'shortcut';

export default function OnboardingScreen() {
  const { update } = useProfile();
  const [step, setStep] = useState<Step>('voiceover');
  const [usesVoiceOver, setUsesVoiceOver] = useState(false);
  const [name, setName] = useState('');
  const [allergiesText, setAllergiesText] = useState('');
  const shortcutUrl = configuredAppleShortcutUrl();
  const shouldOfferShortcut = !!shortcutUrl && isAppleMobileDevice();
  const [questions, setQuestions] = useState<AllergenQuestion[]>([]);
  const [retypeNotice, setRetypeNotice] = useState('');
  const acceptedRef = useRef<string[]>([]);

  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const allergyInputRef = useRef<HTMLInputElement>(null);

  /**
   * The user removed a word we did not recognize. Drop it, keep everything else
   * they typed, and put them back in the allergy field so they can correct it
   * instead of silently moving on without that allergy.
   */
  const removeAndRetype = (removed: string) => {
    setAllergiesText((current) => removeFromList(current, removed));
    setQuestions([]);
    setStep('allergies');
    setRetypeNotice(`Removed ${removed}. Type it again, spelled differently, or leave it out.`);
    // Land focus in the field itself, not the heading, so a correction can be
    // typed straight away.
    window.setTimeout(() => allergyInputRef.current?.focus(), 0);
  };
  useEffect(() => {
    // Move focus to the new step heading so VoiceOver users land on the question
    // instead of stranding on <body> after the previous button unmounts.
    stepHeadingRef.current?.focus();
  }, [step]);

  const finish = async (shortcutChoice: 'opened' | 'skipped' | 'not_offered') => {
    track('onboarding', 'shortcut_choice', { metadata: { choice: shortcutChoice } });
    await update({
      name: cleanName(name),
      allergies: acceptedRef.current,
      usesVoiceOver,
      onboarded: true,
    });
  };

  const continueAfterAllergyReview = (allergies: string[]) => {
    const seen = new Set<string>();
    acceptedRef.current = allergies.filter((allergen) => {
      const key = allergen.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (shouldOfferShortcut) {
      setStep('shortcut');
      return;
    }
    void finish('not_offered');
  };

  const finishAllergyStep = () => {
    const review = reviewAllergenInput(parseList(allergiesText));
    const nextQuestions: AllergenQuestion[] = [
      ...review.corrections.map(([typed, suggested]) => ({ typed, suggested })),
      ...review.unknown.map((typed) => ({ typed })),
    ];
    if (nextQuestions.length > 0) {
      acceptedRef.current = review.accepted;
      setQuestions(nextQuestions);
      setStep('confirm');
      return;
    }
    continueAfterAllergyReview(review.accepted);
  };

  return (
    <Screen className="onboarding-screen">
      {step === 'voiceover' && (
        <div className="col onboarding-step">
          <h1 className="heading onboarding-first-heading" ref={stepHeadingRef} tabIndex={-1}>Do you use VoiceOver?</h1>
          <Body>This helps set up menu scanning.</Body>
          <PrimaryButton label="Yes" onClick={() => { setUsesVoiceOver(true); setStep('name'); }} />
          <SecondaryButton label="No" onClick={() => { setUsesVoiceOver(false); setStep('name'); }} />
        </div>
      )}

      {step === 'name' && (
        <TypeStep
          question="What should I call you?"
          help="Type your first name below."
          placeholder="First name"
          value={name}
          onChange={setName}
          onNext={() => setStep('allergyChoice')}
          nextLabel="Next"
          headingRef={stepHeadingRef}
        />
      )}

      {step === 'allergyChoice' && (
        <div className="col onboarding-step">
          <h2 className="heading" ref={stepHeadingRef} tabIndex={-1}>Do you have food allergies?</h2>
          <Body>Choose one.</Body>
          <PrimaryButton label="Yes" onClick={() => setStep('allergies')} />
          <SecondaryButton label="No" onClick={() => continueAfterAllergyReview([])} />
          <SecondaryButton label="Back" onClick={() => setStep('name')} />
        </div>
      )}

      {step === 'allergies' && (
        <>
          <TypeStep
            question="Any food allergies?"
            help="Type your allergies below."
            placeholder="e.g. shellfish, peanuts"
            value={allergiesText}
            onChange={setAllergiesText}
            onNext={finishAllergyStep}
            nextLabel={shouldOfferShortcut ? 'Next' : 'Finish'}
            onBack={() => setStep('allergyChoice')}
            headingRef={stepHeadingRef}
            inputRef={allergyInputRef}
          />
          <p role="status" aria-live="polite" className="body" style={{ minHeight: 24, margin: 0 }}>
            {retypeNotice}
          </p>
        </>
      )}

      {step === 'shortcut' && shortcutUrl && (
        <div className="col">
          <h2 className="heading" ref={stepHeadingRef} tabIndex={-1}>Open Meet My Menu AI with Siri</h2>
          <Body>Create a Shortcut so saying “Siri, launch Meet My Menu AI” opens this app.</Body>
          <a
            className="btn btn-primary"
            href={shortcutUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
            aria-label="Create Siri Shortcut. Opens Apple's Shortcut page in a new tab"
            onClick={() => void finish('opened')}
          >
            Create Siri Shortcut
          </a>
          <SecondaryButton
            label="Skip for now"
            hint="Continue to Meet My Menu AI. You can create the Shortcut later in Settings"
            onClick={() => void finish('skipped')}
          />
        </div>
      )}

      {step === 'confirm' && (
        <div className="col">
          <h2 className="heading" ref={stepHeadingRef} tabIndex={-1}>
            Check this
          </h2>
          <AllergenReviewPanel
            questions={questions}
            onDone={(kept) => continueAfterAllergyReview([...acceptedRef.current, ...kept])}
            onRetype={removeAndRetype}
          />
          <SecondaryButton label="Back" onClick={() => setStep('allergies')} />
        </div>
      )}
    </Screen>
  );
}

function TypeStep({
  question,
  help,
  placeholder,
  value,
  onChange,
  onNext,
  nextLabel,
  onBack,
  headingRef,
  inputRef,
}: {
  question: string;
  help: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  nextLabel: string;
  onBack?: () => void;
  headingRef?: RefObject<HTMLHeadingElement>;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  return (
    <div className="col onboarding-step">
      <h2 className="heading" ref={headingRef} tabIndex={-1}>{question}</h2>
      <Body>{help}</Body>

      <input
        className="input onboarding-input"
        type="text"
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`${question} Type your answer here`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onNext();
        }}
      />

      <PrimaryButton label={nextLabel} onClick={onNext} />
      {onBack ? <SecondaryButton label="Back" onClick={onBack} /> : null}
    </div>
  );
}
