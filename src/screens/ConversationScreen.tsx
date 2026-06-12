// Unified menu + voice conversation screen.
//
// Layout: phase indicator → latest exchange → controls → semantic MenuDocument.
//
// Voice mode ON (default):
//   App streams TTS sentence-by-sentence; mic auto-opens after each reply.
//   Tap the action button while speaking to interrupt and start talking.
//   Turn cues: earconSpeak (app speaking), earconThinking (thinking),
//              earconStart+vibrate (user turn), earconStop+vibrate (heard you).
//
// Voice mode OFF:
//   App is silent; user browses the semantic MenuDocument with VoiceOver.
//   Conversation text is still updated in an aria-live region.

import { useEffect, useRef, useState } from 'react';
import { Screen, SecondaryButton } from '../components';
import { ScreenProps, Route } from '../nav';
import { ChatTurn, ParsedMenu } from '../types';
import { useProfile } from '../state/ProfileContext';
import { speak, stopSpeaking, createStreamingSpeech } from '../lib/speech';
import {
  SpeechManager,
  isSpeechRecognitionSupported,
} from '../lib/speechRecognition';
import { buildOpeningLine, chatReplyStream, extractSessionLearnings, hasApiKey } from '../lib/openai';
import { track } from '../lib/telemetry';
import {
  earconStart,
  earconStop,
  earconError,
  earconSpeak,
  earconThinkingStart,
  earconThinkingStop,
} from '../lib/earcon';
import { mergeUnique } from '../util';

type Phase = 'speaking' | 'idle' | 'recording' | 'transcribing' | 'thinking' | 'error';

const EXIT_PHRASES = [
  'go home', 'go back', 'exit', 'quit', 'i am done', "i'm done", 'all done', 'finished',
  'end conversation', 'goodbye', 'bye', 'that is all', "that's all",
];

const REPEAT_PHRASES = [
  'repeat that', 'say that again', 'what did you say', 'say it again', 'pardon', 'come again',
];

// Semantic menu document — VoiceOver heading rotor hierarchy:
//   h1 restaurant → h2 category (with item count) → h3 dish (name + price in one
//   heading, so a single rotor stop reads both) → h4 Description / Ingredients.
function MenuDocument({
  menu,
  headingRef,
}: {
  menu: ParsedMenu;
  headingRef?: React.RefObject<HTMLHeadingElement>;
}) {
  return (
    <section aria-label="Full menu. Browse with VoiceOver heading rotor" style={{ marginTop: 24 }}>
      <h2
        ref={headingRef}
        tabIndex={-1}
        style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}
      >
        Full menu
      </h2>
      {menu.categories.map((cat) => (
        <section key={cat.name}>
          <h2 className="browse-category">
            {cat.name}
            <span style={{ fontWeight: 400, fontSize: '0.7em' }}>
              {' '}({cat.items.length} item{cat.items.length === 1 ? '' : 's'})
            </span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, marginBottom: 24 }}>
            {cat.items.map((item) => (
              <article key={item.name} className="browse-item">
                <h3 className="browse-item-name">
                  {item.name}
                  {item.price && (
                    <span className="browse-item-price">{' '}{item.price}</span>
                  )}
                </h3>
                {item.description && (
                  <>
                    <h4 className="browse-item-sub">Description</h4>
                    <p className="browse-item-desc">{item.description}</p>
                  </>
                )}
                {item.ingredients && item.ingredients.length > 0 && (
                  <>
                    <h4 className="browse-item-sub">Ingredients</h4>
                    <p className="browse-item-desc">{item.ingredients.join(', ')}</p>
                  </>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
      {menu.notes && (
        <section>
          <h2 className="browse-category">Notes</h2>
          <p className="body" style={{ marginTop: 8 }}>{menu.notes}</p>
        </section>
      )}
    </section>
  );
}

export default function ConversationScreen({
  navigate,
  route,
}: ScreenProps & { route: Extract<Route, { name: 'conversation' }> }) {
  const { profile, update } = useProfile();
  const { menu, restaurantName } = route;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [latestUser, setLatestUser] = useState('');
  const [latestAssistant, setLatestAssistant] = useState('');
  const [liveText, setLiveText] = useState('');
  const [phase, setPhase] = useState<Phase>('speaking');
  const [speakMode, setSpeakMode] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const started = useRef(false);
  const speechManagerRef = useRef<SpeechManager | null>(null);
  const processUtteranceRef = useRef<(text: string) => Promise<void>>(async () => {});
  const startMicRef = useRef<() => Promise<void>>(async () => {});
  const speakModeRef = useRef(true);
  speakModeRef.current = speakMode;
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const menuHeadingRef = useRef<HTMLHeadingElement>(null);

  // Opening: speak menu overview on first mount.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const base = buildOpeningLine(menu);
      const opening =
        route.source === 'url'
          ? `${base} Just a heads up. This menu is from the website you shared, so it should be their current version, but details may vary.`
          : base;
      setTurns([{ role: 'assistant', text: opening }]);
      setLatestAssistant(opening);
      setPhase('speaking');
      earconSpeak();
      await speak(opening, profile.ttsVoice);
      await startMicRef.current();
    })();
    return () => {
      earconThinkingStop();
      stopSpeaking();
      speechManagerRef.current?.destroy();
      speechManagerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startMic = async () => {
    // Audio must be stopped before opening the mic — otherwise the recognizer
    // hears the app's own voice on iOS Safari.
    stopSpeaking();

    if (!isSpeechRecognitionSupported()) {
      const msg = 'Voice input is not supported in this browser. Try Chrome or Safari.';
      setErrorMsg(msg);
      setPhase('error');
      await speak(msg, profile.ttsVoice);
      return;
    }

    speechManagerRef.current?.destroy();
    speechManagerRef.current = new SpeechManager(
      (userText: string) => {
        earconStop();
        try { navigator.vibrate?.([80]); } catch {}
        processUtteranceRef.current(userText);
      },
      async (msg: string) => {
        earconError();
        try { navigator.vibrate?.([200, 50, 200]); } catch {}
        setErrorMsg(msg);
        setPhase('error');
        await speak(msg, profile.ttsVoice);
      },
    );

    earconStart();
    try { navigator.vibrate?.([30, 40, 30]); } catch {}
    await new Promise<void>((r) => setTimeout(r, 150));
    speechManagerRef.current.start();
    setPhase('recording');
  };
  startMicRef.current = startMic;

  const processUtterance = async (userText: string) => {
    setPhase('transcribing');

    if (!userText.trim()) {
      await sayReply("I didn't catch that. Could you say it again?");
      return;
    }

    track('ask', 'user_utterance', {
      content: { text: userText },
      metadata: { history_len: turns.length },
    });

    const t = userText.toLowerCase().trim();
    const hadExchange = turns.some((x) => x.role === 'user');

    const isExit =
      hadExchange &&
      EXIT_PHRASES.some((p) => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
    if (isExit) {
      track('ask', 'exit_phrase', { content: { text: t } });
      await sayReply("Of course. I'll save what we talked about. Goodbye!", undefined, false);
      finish();
      return;
    }

    const isRepeat = REPEAT_PHRASES.some((p) => t.includes(p));
    if (isRepeat) {
      track('ask', 'repeat_phrase', { content: { text: t } });
      const last = [...turns].reverse().find((x) => x.role === 'assistant');
      if (last) { await sayReply(last.text); return; }
    }

    const history = turns;
    const withUser: ChatTurn[] = [...history, { role: 'user' as const, text: userText }];
    setTurns(withUser);
    track('message', 'turn', { content: { role: 'user', text: userText }, metadata: { turn_index: withUser.length } });
    setLatestUser(userText);
    setLiveText('');
    setPhase('thinking');
    earconThinkingStart();

    if (speakModeRef.current) {
      const streamer = createStreamingSpeech(profile.ttsVoice, {
        onSpeakingStart: () => {
          earconThinkingStop();
          earconSpeak();
          try { navigator.vibrate?.([50]); } catch {}
          setPhase('speaking');
        },
      });

      let fullReply = '';
      try {
        fullReply = await chatReplyStream(menu, profile, history, userText, (delta) => {
          streamer.push(delta);
          setLiveText((prev) => prev + delta);
        });
        await streamer.finish();
      } catch (e: any) {
        earconThinkingStop();
        earconError();
        try { navigator.vibrate?.([200, 50, 200]); } catch {}
        const msg = e?.message ?? "Something went wrong. Let's try that again.";
        setErrorMsg(msg);
        setPhase('error');
        await speak(msg, profile.ttsVoice);
        return;
      }

      const withReply: ChatTurn[] = [...withUser, { role: 'assistant', text: fullReply }];
      setTurns(withReply);
      track('message', 'turn', { content: { role: 'assistant', text: fullReply }, metadata: { turn_index: withReply.length } });
      setLatestAssistant(fullReply);
      setLiveText('');
      await startMic();
    } else {
      // Silent mode: get reply as text only, no audio.
      let fullReply = '';
      try {
        fullReply = await chatReplyStream(menu, profile, history, userText, (delta) => {
          setLiveText((prev) => prev + delta);
        });
      } catch (e: any) {
        earconThinkingStop();
        earconError();
        const msg = e?.message ?? "Something went wrong. Let's try that again.";
        setErrorMsg(msg);
        setPhase('error');
        return;
      }
      earconThinkingStop();
      const withReply: ChatTurn[] = [...withUser, { role: 'assistant', text: fullReply }];
      setTurns(withReply);
      track('message', 'turn', { content: { role: 'assistant', text: fullReply }, metadata: { turn_index: withReply.length } });
      setLatestAssistant(fullReply);
      setLiveText('');
      setPhase('idle');
    }
  };

  processUtteranceRef.current = processUtterance;

  // Non-streaming reply for errors, repeat, exit phrases.
  const sayReply = async (
    text: string,
    baseTurns?: ChatTurn[],
    listen = speakModeRef.current,
  ) => {
    const base = baseTurns ?? turns;
    const withReply: ChatTurn[] = [...base, { role: 'assistant' as const, text }];
    setTurns(withReply);
    setLatestAssistant(text);
    setPhase('speaking');
    if (speakModeRef.current) {
      earconSpeak();
      try { navigator.vibrate?.([50]); } catch {}
      await speak(text, profile.ttsVoice);
    }
    if (listen && speakModeRef.current) await startMic();
    else setPhase('idle');
  };

  const finish = async () => {
    earconThinkingStop();
    stopSpeaking();
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
      } catch {}
    }
    navigate({ name: 'home' });
  };

  const toggleSpeakMode = () => {
    const next = !speakMode;
    setSpeakMode(next);
    track('conversation', 'mode_toggle', { metadata: { mode: next ? 'voice' : 'browse' } });
    if (!next) {
      stopSpeaking();
      // Browse mode: land on the menu heading so VoiceOver starts at content
      setTimeout(() => menuHeadingRef.current?.focus(), 50);
    } else {
      // Voice mode: land on the action button ready to speak
      setTimeout(() => actionButtonRef.current?.focus(), 50);
    }
  };

  const displayText = liveText || latestAssistant;
  const indicator = indicatorFor(phase);

  // Single action whose label and handler derive from the current phase.
  const actionConfig = (() => {
    switch (phase) {
      case 'speaking':
        return {
          label: 'Stop and talk',
          hint: 'Interrupt and start speaking',
          disabled: false,
          onClick: () => { stopSpeaking('bargein'); startMicRef.current(); },
        };
      case 'idle':
        return {
          label: 'Tap to talk',
          hint: 'Start speaking to MenuVoice',
          disabled: false,
          onClick: () => startMic(),
        };
      case 'recording':
        return {
          label: "Tap when you're done",
          hint: 'Submit what you just said without waiting',
          disabled: false,
          onClick: () => speechManagerRef.current?.submitNow(),
        };
      case 'thinking':
      case 'transcribing':
        return {
          label: 'One moment…',
          hint: '',
          disabled: true,
          onClick: () => {},
        };
      case 'error':
        return {
          label: 'Try again',
          hint: '',
          disabled: false,
          onClick: () => { setErrorMsg(''); startMic(); },
        };
    }
  })();

  return (
    <Screen>
      <h1 className="heading" style={{ marginTop: 4 }}>{restaurantName}</h1>

      {/* Incomplete-menu notice — first thing on the page, one sentence, with
          the option to supplement by adding photos. */}
      {menu.incomplete && (
        <div
          role="note"
          style={{
            background: 'var(--surface-high)',
            border: '2px solid var(--accent)',
            borderRadius: 'var(--r-md)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <p className="body" style={{ margin: 0, fontWeight: 600 }}>
            This wasn't a complete menu.
          </p>
          <button
            className="btn btn-secondary"
            style={{ minHeight: 56 }}
            aria-label="Add photos of the missing parts of the menu"
            onClick={() => {
              stopSpeaking();
              speechManagerRef.current?.destroy();
              navigate({ name: 'capture', appendTo: { menu, restaurantName } });
            }}
          >
            Add menu photos
          </button>
        </div>
      )}

      {/* aria-live OFF while recording: otherwise VoiceOver announces the phase
          change into the open mic and the recognizer transcribes VoiceOver itself. */}
      <div
        role="status"
        aria-live={phase === 'recording' ? 'off' : 'polite'}
        aria-label={indicator.label}
        className={`phase-indicator phase-${phaseClass(phase)}`}
      >
        <span className="phase-dot" aria-hidden="true" />
        {indicator.label}
      </div>

      {/* Latest exchange */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 80,
        }}
      >
        {/* "You said" — live because the app does not speak user words back */}
        <div aria-live="polite" aria-atomic="true">
          {latestUser && (
            <div
              aria-label={`You said: ${latestUser}`}
              className="turn turn-user"
            >
              <div className="turn-speaker">You</div>
              <div className="turn-text">{latestUser}</div>
            </div>
          )}
        </div>
        {/* Assistant reply — off: app already speaks it; VoiceOver can navigate here on demand */}
        {displayText && (
          <div aria-live="off" className="turn turn-assistant">
            <div className="turn-speaker">MenuVoice</div>
            <div className="turn-text">{displayText}</div>
          </div>
        )}
      </div>

      {/* Error message — announced immediately via role="alert" */}
      {phase === 'error' && errorMsg && (
        <p role="alert" className="body" style={{ color: 'var(--danger)', textAlign: 'center' }}>
          {errorMsg}
        </p>
      )}

      {/* Single state-aware action button */}
      <button
        ref={actionButtonRef}
        className="btn btn-primary"
        onClick={actionConfig.onClick}
        disabled={actionConfig.disabled}
        aria-label={actionConfig.hint ? `${actionConfig.label}. ${actionConfig.hint}` : actionConfig.label}
        style={{ minHeight: 110 }}
      >
        {actionConfig.label}
      </button>

      {/* Mode switch — label states current mode and names what the tap will do */}
      <button
        onClick={toggleSpeakMode}
        aria-pressed={speakMode}
        aria-label={
          speakMode
            ? 'Currently in voice mode. Activate to switch to browse mode.'
            : 'Currently in browse mode. Activate to switch to voice mode.'
        }
        className="btn btn-secondary"
        style={{
          minHeight: 64,
          border: `2px solid ${speakMode ? 'var(--accent)' : 'var(--border)'}`,
          background: speakMode ? 'var(--surface-high)' : 'var(--surface)',
          color: speakMode ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        {speakMode ? 'Voice mode' : 'Browse mode'}
      </button>

      <SecondaryButton
        label={saving ? 'Saving preferences…' : 'Done'}
        hint="Save what you decided and return home"
        onClick={finish}
        disabled={saving}
      />

      {/* Semantic menu — VoiceOver heading rotor: h1 restaurant → h2 category → h3 item */}
      <MenuDocument menu={menu} headingRef={menuHeadingRef} />
    </Screen>
  );
}

function indicatorFor(phase: Phase): { label: string } {
  switch (phase) {
    case 'speaking':     return { label: 'MenuVoice is speaking…' };
    case 'idle':         return { label: 'Your turn. Tap to talk' };
    case 'recording':    return { label: 'Listening. Tap when you\'re done' };
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
