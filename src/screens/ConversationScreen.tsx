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
import { startRecording, stopRecording, requestMicPermission } from '../lib/recorder';
import { buildOpeningLine, transcribeAudio, chatReply, extractSessionLearnings, hasApiKey } from '../lib/openai';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const opening = buildOpeningLine(menu);
      setTurns([{ role: 'assistant', text: opening }]);
      setPhase('speaking');
      await speak(opening, profile.ttsVoice);
      setPhase('idle');
    })();
    return () => stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);
    return () => clearTimeout(id);
  }, [turns]);

  const beginListening = async () => {
    if (phase !== 'idle') return;
    const ok = await requestMicPermission();
    if (!ok) {
      setErrorMsg('I need microphone access to hear you. Allow it and try again.');
      setPhase('error');
      return;
    }
    try {
      await startRecording();
      setPhase('recording');
    } catch {
      setErrorMsg('I could not start the microphone. Try again.');
      setPhase('error');
    }
  };

  const finishListening = async () => {
    if (phase !== 'recording') return;
    setPhase('transcribing');
    let blob: Blob | null = null;
    try {
      blob = await stopRecording();
    } catch {
      blob = null;
    }
    if (!blob) {
      setPhase('idle');
      return;
    }
    try {
      const userText = await transcribeAudio(blob);
      if (!userText) {
        await say("I didn't catch that. Could you say it again?");
        setPhase('idle');
        return;
      }

      // Intercept clear navigation/exit commands so they don't go to the menu LLM.
      const t = userText.toLowerCase().trim();
      const hadExchange = turns.some((x) => x.role === 'user');
      const isExit =
        hadExchange &&
        EXIT_PHRASES.some((p) => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
      if (isExit) {
        await say("Of course. I'll save what we talked about. Goodbye!");
        finish();
        return;
      }

      // "Repeat that" — replay last assistant message without hitting the LLM.
      const isRepeat = REPEAT_PHRASES.some((p) => t.includes(p));
      if (isRepeat) {
        const lastAssistant = [...turns].reverse().find((x) => x.role === 'assistant');
        if (lastAssistant) {
          await say(lastAssistant.text);
          setPhase('idle');
          return;
        }
      }

      const history = turns;
      const withUser: ChatTurn[] = [...history, { role: 'user', text: userText }];
      setTurns(withUser);
      setPhase('thinking');
      const reply = await chatReply(menu, profile, history, userText);
      await say(reply, withUser);
      setPhase('idle');
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Something went wrong. Let's try that again.");
      setPhase('error');
    }
  };


  const say = async (text: string, baseHistory?: ChatTurn[]) => {
    const base = baseHistory ?? turns;
    setTurns([...base, { role: 'assistant', text }]);
    setPhase('speaking');
    await speak(text, profile.ttsVoice);
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
        aria-live="polite"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          border: `2px solid ${indicator.color}`,
          borderRadius: 'var(--r-md)',
          padding: '16px',
          color: indicator.color,
          fontSize: 22,
          fontWeight: 700,
        }}
      >
        {indicator.label}
      </div>

      <div
        ref={scrollRef}
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
            style={{
              alignSelf: turn.role === 'assistant' ? 'flex-start' : 'flex-end',
              maxWidth: '92%',
              background: turn.role === 'assistant' ? 'var(--surface-high)' : '#2a2320',
              borderRadius: 'var(--r-md)',
              padding: '12px 14px',
            }}
          >
            <div style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
              {turn.role === 'assistant' ? 'MenuVoice' : 'You'}
            </div>
            <div style={{ fontSize: 18, lineHeight: 1.4 }}>{turn.text}</div>
          </div>
        ))}
      </div>

      {phase === 'error' ? (
        <div className="col">
          <p className="body" style={{ color: 'var(--danger)', textAlign: 'center' }}>
            {errorMsg}
          </p>
          <PrimaryButton
            label="Try again"
            onClick={() => {
              setErrorMsg('');
              setPhase('idle');
            }}
          />
        </div>
      ) : phase === 'speaking' ? (
        <div className="col" style={{ gap: 8 }}>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: 'var(--surface-high)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: '100%',
                background: 'var(--accent)',
                animation: 'pulse-bar 1.4s ease-in-out infinite',
                transformOrigin: 'left',
              }}
            />
          </div>
          <SecondaryButton
            label="Skip"
            hint="Stop speaking and go to your turn"
            onClick={() => { stopSpeaking(); setPhase('idle'); }}
            style={{ minHeight: 70 }}
          />
        </div>
      ) : phase === 'recording' ? (
        <PrimaryButton
          label="■  Done speaking"
          hint="Stop listening and get a response"
          onClick={finishListening}
          style={{ minHeight: 110, background: 'var(--success)', animation: 'mic-pulse 1.5s ease-out infinite' }}
        />
      ) : (
        <PrimaryButton
          label={phase === 'idle' ? '🎤  Tap to talk' : 'Please wait…'}
          hint="Start speaking to MenuVoice"
          onClick={beginListening}
          disabled={phase !== 'idle'}
          style={{ minHeight: 110 }}
        />
      )}

      <SecondaryButton
        label={saving ? 'Saving your preferences…' : 'Done'}
        hint="Save what you decided and return home"
        onClick={finish}
        disabled={saving}
      />
    </Screen>
  );
}

function indicatorFor(phase: Phase): { label: string; color: string } {
  switch (phase) {
    case 'speaking':
      return { label: 'MenuVoice is speaking…', color: 'var(--accent)' };
    case 'idle':
      return { label: 'Your turn — tap to talk', color: 'var(--success)' };
    case 'recording':
      return { label: 'Listening… tap Done when finished', color: 'var(--success)' };
    case 'transcribing':
      return { label: 'Hearing you…', color: 'var(--text-secondary)' };
    case 'thinking':
      return { label: 'Thinking…', color: 'var(--text-secondary)' };
    case 'error':
      return { label: 'Something needs your attention', color: 'var(--danger)' };
  }
}
