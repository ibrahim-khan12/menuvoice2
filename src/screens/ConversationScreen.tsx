// THE CORE SCREEN. Strict turn-taking voice conversation about the menu.
//
// State machine (the app never listens while it is speaking):
//   speaking  -> app is talking; mic disabled
//   idle      -> waiting for the guest; mic enabled ("Tap to talk")
//   recording -> guest is talking; they tap "Done" when finished (never cut off)
//   transcribing / thinking -> processing; mic disabled
//
// Turn-taking guarantee: recording stops only on the guest's tap, so the app
// can never cut someone off mid-sentence.

import { useEffect, useRef, useState } from 'react';
import { Screen, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps, Route } from '../nav';
import { ChatTurn } from '../types';
import { useProfile } from '../state/ProfileContext';
import { speak, stopSpeaking } from '../lib/speech';
import { SpeechManager, isSpeechRecognitionSupported } from '../lib/speechRecognition';
import { buildOpeningLine, chatReply, extractSessionLearnings, hasApiKey } from '../lib/openai';
import { earconStart, earconStop, earconError } from '../lib/earcon';
import { mergeUnique } from '../util';

type Phase = 'speaking' | 'idle' | 'recording' | 'transcribing' | 'thinking' | 'error';

// Short, unambiguous exit phrases. Kept tight so "I'm done with the pasta" doesn't trigger.
const EXIT_PHRASES = [
  'go home', 'go back', 'exit', 'quit', 'i am done', "i'm done", 'all done', 'finished',
  'end conversation', 'stop', 'goodbye', 'bye', 'that is all', "that's all",
];

const REPEAT_PHRASES = ['repeat that', 'say that again', 'what did you say', 'say it again', 'pardon', 'come again'];

export default function ConversationScreen({
  navigate,
  route,
}: ScreenProps & { route: Extract<Route, { name: 'conversation' }> }) {
  const { profile, update } = useProfile();
  const { menu, restaurantName } = route;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [phase, setPhase] = useState<Phase>('speaking');
  const [errorMsg, setErrorMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [autoListen, setAutoListen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const speechManagerRef = useRef<SpeechManager | null>(null);
  // Always points to the latest processUtterance so the SpeechManager callback never goes stale.
  const processUtteranceRef = useRef<(text: string) => Promise<void>>(async () => {});

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const base = buildOpeningLine(menu);
      const opening = route.source === 'url'
        ? `${base} Just a heads up — this menu is pulled from the website you shared, so it should be their most current version, but we can't guarantee every detail is accurate.`
        : base;
      setTurns([{ role: 'assistant', text: opening }]);
      setPhase('speaking');
      await speak(opening, profile.ttsVoice);
      await startMic();
    })();
    return () => {
      stopSpeaking();
      speechManagerRef.current?.destroy();
      speechManagerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);
    return () => clearTimeout(id);
  }, [turns]);

  // Start listening — called both manually and automatically after speaking.
  // Uses Web Speech API (webkitSpeechRecognition) instead of MediaRecorder + VAD.
  // The browser's native silence detection submits the transcript after 2s of quiet.
  const startMic = async () => {
    if (!isSpeechRecognitionSupported()) {
      const msg = 'Voice input is not supported in this browser. Try Chrome or Safari.';
      setErrorMsg(msg);
      setPhase('error');
      await speak(msg, profile.ttsVoice);
      return;
    }

    // Fresh SpeechManager each turn — iOS accumulates transcripts across sessions
    // if you reuse the same recognition instance, causing doubled/garbled results.
    speechManagerRef.current?.destroy();
    speechManagerRef.current = new SpeechManager(
      // onTranscript: browser silence detection fired — user finished speaking
      (userText: string) => {
        earconStop();
        try { navigator.vibrate?.([80]); } catch {} // single pulse = mic closed
        processUtteranceRef.current(userText);
      },
      // onError: permission denied or capture failure
      async (msg: string) => {
        earconError();
        setErrorMsg(msg);
        setPhase('error');
        await speak(msg, profile.ttsVoice);
      },
    );

    earconStart();
    // Vibrate to signal mic is open — essential for blind users who can't see the indicator.
    try { navigator.vibrate?.([30, 40, 30]); } catch {}
    // 150ms gap: lets iOS audio system settle after TTS so recognition doesn't
    // capture the tail of the app's own speech as the user's first words.
    await new Promise<void>((r) => setTimeout(r, 150));
    speechManagerRef.current.start();
    setPhase('recording');
  };

  const beginListening = async () => {
    if (phase !== 'idle') return;
    await startMic();
  };

  // Called by SpeechManager once the user has finished speaking (2s silence).
  // Also called directly when user taps "Done talking" (via submitNow).
  const processUtterance = async (userText: string) => {
    setPhase('transcribing');

    if (!userText.trim()) {
      await say("I didn't catch that. Could you say it again?");
      return;
    }

    const t = userText.toLowerCase().trim();
    const hadExchange = turns.some((x) => x.role === 'user');

    // Intercept clear exit phrases so they don't go to the menu LLM.
    const isExit =
      hadExchange &&
      EXIT_PHRASES.some((p) => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
    if (isExit) {
      await say("Of course. I'll save what we talked about. Goodbye!", undefined, false);
      finish();
      return;
    }

    // "Repeat that" — replay last assistant message without hitting the LLM.
    const isRepeat = REPEAT_PHRASES.some((p) => t.includes(p));
    if (isRepeat) {
      const lastAssistant = [...turns].reverse().find((x) => x.role === 'assistant');
      if (lastAssistant) {
        await say(lastAssistant.text);
        return;
      }
    }

    const history = turns;
    const withUser: ChatTurn[] = [...history, { role: 'user', text: userText }];
    setTurns(withUser);
    setPhase('thinking');

    try {
      const reply = await chatReply(menu, profile, history, userText);
      await say(reply, withUser);
    } catch (e: any) {
      const msg = e?.message ?? "Something went wrong. Let's try that again.";
      setErrorMsg(msg);
      setPhase('error');
      await speak(msg, profile.ttsVoice);
    }
  };

  // Keep the ref in sync every render so the SpeechManager callback never closes over stale state.
  processUtteranceRef.current = processUtterance;

  const say = async (text: string, baseHistory?: ChatTurn[], listen = autoListen) => {
    const base = baseHistory ?? turns;
    setTurns([...base, { role: 'assistant', text }]);
    setPhase('speaking');
    await speak(text, profile.ttsVoice);
    if (listen) await startMic();
    else setPhase('idle');
  };

  // Leaving the conversation: capture what they decided + their taste, then go home.
  const finish = async () => {
    await stopSpeaking();
    const hasUser = turns.some((t) => t.role === 'user');
    if (hasUser && hasApiKey()) {
      setSaving(true);
      try {
        const learn = await extractSessionLearnings(turns);
        await update({
          pastOrders: mergeUnique(profile.pastOrders, learn.orders),
          cuisinesLiked: mergeUnique(profile.cuisinesLiked, learn.likes),
          dislikes: mergeUnique(profile.dislikes, learn.dislikes),
        });
      } catch {
        // best-effort; never block the exit
      }
    }
    navigate({ name: 'home' });
  };

  const indicator = indicatorFor(phase);

  return (
    <Screen>
      <h2 className="heading" style={{ marginTop: 4 }}>
        {restaurantName}
      </h2>

      <div
        role="status"
        aria-live="polite"
        aria-label={indicator.label}
        className={`phase-indicator phase-${phaseClass(phase)}`}
      >
        <span className="phase-dot" aria-hidden="true" />
        {indicator.label}
      </div>

      <div
        ref={scrollRef}
        aria-live="polite"
        aria-relevant="additions"
        style={{
          flex: 1,
          overflowY: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {turns.map((turn, i) => (
          <div
            key={i}
            aria-label={`${turn.role === 'assistant' ? 'MenuVoice' : 'You'} said: ${turn.text}`}
            className={`turn turn-${turn.role}`}
          >
            <div className="turn-speaker">
              {turn.role === 'assistant' ? 'MenuVoice' : 'You'}
            </div>
            <div className="turn-text">{turn.text}</div>
          </div>
        ))}
      </div>

      {phase === 'error' ? (
        <div className="col">
          <p role="alert" className="body" style={{ color: 'var(--danger)', textAlign: 'center' }}>
            {errorMsg}
          </p>
          <PrimaryButton
            label="Try again"
            onClick={() => {
              setErrorMsg('');
              startMic();
            }}
          />
        </div>
      ) : phase === 'speaking' ? (
        <div className="col" style={{ gap: 8 }}>
          <div
            aria-hidden="true"
            style={{
              height: 8,
              borderRadius: 4,
              background: 'var(--surface-high)',
              overflow: 'hidden',
            }}
          >
            <div className="speaking-bar" />
          </div>
          <SecondaryButton
            label="Skip"
            hint="Stop speaking and go to your turn"
            onClick={() => { stopSpeaking(); if (autoListen) startMic(); else setPhase('idle'); }}
            style={{ minHeight: 70 }}
          />
        </div>
      ) : phase === 'recording' ? (
        <div className="col" style={{ gap: 8 }}>
          <div
            role="status"
            aria-live="polite"
            style={{
              minHeight: 70,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--r-md)',
              border: '2px solid var(--success)',
              background: 'rgba(109, 214, 138, 0.12)',
              color: 'var(--success)',
              fontWeight: 700,
              fontSize: 20,
              letterSpacing: '-0.01em',
            }}
          >
            Listening… speak now
          </div>
          <SecondaryButton
            label="Done talking"
            hint="Submit what you just said without waiting"
            onClick={() => speechManagerRef.current?.submitNow()}
            style={{ minHeight: 64 }}
          />
        </div>
      ) : (
        <PrimaryButton
          label={phase === 'idle' ? 'Tap to talk' : 'Please wait…'}
          hint="Start speaking to MenuVoice"
          onClick={beginListening}
          disabled={phase !== 'idle'}
          style={{ minHeight: 110 }}
        />
      )}

      <button
        onClick={() => setAutoListen((v) => !v)}
        aria-pressed={autoListen}
        aria-label={`Conversational mode ${autoListen ? 'on' : 'off'}. Tap to turn ${autoListen ? 'off' : 'on'}.`}
        className="btn"
        style={{
          minHeight: 64,
          border: `2px solid ${autoListen ? 'var(--accent)' : 'var(--border)'}`,
          background: autoListen ? 'var(--surface-high)' : 'var(--surface)',
          color: autoListen ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        {autoListen ? '⦿ Conversational: ON' : '○ Conversational: OFF'}
      </button>

      <SecondaryButton
        label={saving ? 'Saving your preferences…' : 'Done'}
        hint="Save what you decided and return home"
        onClick={finish}
        disabled={saving}
      />
      <SecondaryButton
        label="Browse menu silently"
        hint="Read the menu without audio — navigable by VoiceOver heading rotor"
        onClick={() => { stopSpeaking(); navigate({ name: 'browse', menu, restaurantName }); }}
      />
    </Screen>
  );
}

function indicatorFor(phase: Phase): { label: string } {
  switch (phase) {
    case 'speaking':     return { label: 'MenuVoice is speaking…' };
    case 'idle':         return { label: 'Your turn — tap to talk' };
    case 'recording':    return { label: "Listening… I'll respond when you stop talking" };
    case 'transcribing': return { label: 'Hearing you…' };
    case 'thinking':     return { label: 'Thinking…' };
    case 'error':        return { label: 'Something needs your attention' };
  }
}

function phaseClass(phase: Phase): string {
  switch (phase) {
    case 'speaking':     return 'speaking';
    case 'idle':         return 'idle';
    case 'recording':    return 'recording';
    case 'transcribing':
    case 'thinking':     return 'processing';
    case 'error':        return 'error';
  }
}
