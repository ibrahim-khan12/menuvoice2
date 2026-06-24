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

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Screen, SecondaryButton } from '../components';
import { ScreenProps, Route } from '../nav';
import { ChatTurn, ParsedMenu } from '../types';
import { useProfile } from '../state/ProfileContext';
import { usePause } from '../state/PauseContext';
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

// One dish item's spoken text: name, price, description, and ingredients folded
// into a single natural line. Price is read as part of the dish, never as its
// own stop.
function dishLabel(item: ParsedMenu['categories'][number]['items'][number]): string {
  let label = item.name;
  if (item.price) label += `, ${item.price}`;
  if (item.description) label += `. ${item.description}`;
  if (item.ingredients && item.ingredients.length > 0) {
    label += `. Ingredients: ${item.ingredients.join(', ')}`;
  }
  return label;
}

// Semantic menu document. Categories are collapsed by default so VoiceOver does
// not read through every dish on arrival. Each category heading contains the
// expand/collapse button, and dishes only render after the category is open.
//
// When a category is open:
//   h2 "Menu categories" -> h3 category button -> list item dish.
// Categories are heading rotor stops. Dishes are regular list items with one
// accessible name, so left/right swipes move through dishes after a category is
// opened.
function MenuDocument({
  menu,
  headingRef,
}: {
  menu: ParsedMenu;
  headingRef?: React.RefObject<HTMLHeadingElement>;
}) {
  // Track which categories are expanded. Empty = all collapsed (default), so
  // VoiceOver only sees the category buttons until the user opens one.
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});

  const toggleCategory = (name: string) => {
    setOpenCategories((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      track('conversation', 'category_toggle', {
        metadata: { category: name, open: next[name] },
      });
      return next;
    });
  };

  return (
    <section aria-label="Menu by category. Open a category to read its dishes." style={{ marginTop: 24 }}>
      <h2
        ref={headingRef}
        tabIndex={-1}
        style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}
      >
        Menu categories
      </h2>
      {menu.categories.map((cat) => {
        const open = !!openCategories[cat.name];
        const panelId = `category-panel-${cat.name.replace(/\s+/g, '-').toLowerCase()}`;
        const count = `${cat.items.length} item${cat.items.length === 1 ? '' : 's'}`;
        return (
          <section key={cat.name} style={{ marginBottom: 12 }}>
            <h3 className="browse-category-heading" aria-label={`${cat.name}, ${count}`}>
              <button
              className="btn btn-secondary browse-category-toggle"
              onClick={() => toggleCategory(cat.name)}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${cat.name}, ${count}. ${open ? 'Open. Activate to hide dishes.' : 'Activate to show dishes.'}`}
              style={{ minHeight: 64, width: '100%', justifyContent: 'space-between', textAlign: 'left' }}
            >
              <span aria-hidden="true">{cat.name}</span>
              <span aria-hidden="true" style={{ fontWeight: 400, fontSize: '0.8em' }}>
                {count} {open ? '▾' : '▸'}
              </span>
              </button>
            </h3>
            {open && (
              <ul
                id={panelId}
                className="browse-item-list"
                style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, marginBottom: 8 }}
              >
                {cat.items.map((item) => (
                  <li key={item.name} className="browse-item" aria-label={dishLabel(item)}>
                    {/* Single list item: the whole dish, spoken from aria-label.
                        Visible content is aria-hidden so it is not read twice
                        and does not land in the heading rotor. */}
                    <p className="browse-item-name" aria-hidden="true">
                      <span aria-hidden="true">{item.name}</span>
                      {item.price && (
                        <span className="browse-item-price" aria-hidden="true">{' '}{item.price}</span>
                      )}
                    </p>
                    {item.description && (
                      <p className="browse-item-desc" aria-hidden="true">{item.description}</p>
                    )}
                    {item.ingredients && item.ingredients.length > 0 && (
                      <p className="browse-item-desc" aria-hidden="true">
                        <span className="browse-item-sub">Ingredients: </span>
                        {item.ingredients.join(', ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
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
  const { paused, registerStopListening } = usePause();
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
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const menuHeadingRef = useRef<HTMLHeadingElement>(null);

  // Opening: speak menu overview on first mount.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const base = buildOpeningLine(menu);
      const onlineNote =
        route.source === 'url'
          ? ' Just a heads up. This menu is from the website you shared, so it should be their current version, but details may vary.'
          : route.source === 'find'
            ? ' Just a heads up. I found this menu online, so it should be current, but details may vary.'
            : '';
      const opening = `${base}${onlineNote}`;
      setTurns([{ role: 'assistant', text: opening }]);
      setLatestAssistant(opening);
      setPhase('speaking');
      earconSpeak();
      await speak(opening, profile.ttsVoice);
      if (pausedRef.current) {
        setPhase('idle');
        return;
      }
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

  useEffect(() => {
    return registerStopListening(() => {
      speechManagerRef.current?.destroy();
      speechManagerRef.current = null;
      setPhase((current) => (current === 'recording' || current === 'speaking' ? 'idle' : current));
    });
  }, [registerStopListening]);

  useEffect(() => {
    if (!paused) return;
    speechManagerRef.current?.destroy();
    speechManagerRef.current = null;
    stopSpeaking();
    earconThinkingStop();
    setPhase((current) => (current === 'recording' || current === 'speaking' ? 'idle' : current));
  }, [paused]);

  const startMic = async () => {
    if (pausedRef.current) {
      setPhase('idle');
      return;
    }
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
      if (pausedRef.current) {
        setPhase('idle');
        return;
      }
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
    if (listen && speakModeRef.current && !pausedRef.current) await startMic();
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

  const interruptAndListen = () => {
    if (pausedRef.current) return;
    stopSpeaking('bargein');
    startMicRef.current();
  };

  const onConversationSurfaceClick = (event: MouseEvent<HTMLElement>) => {
    if (phase !== 'speaking') return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest(
        'button, a, input, select, textarea, label, [role="button"], [role="link"], [role="menuitem"], [role="radio"], [role="checkbox"], [tabindex]:not([tabindex="-1"])',
      )
    ) {
      return;
    }
    interruptAndListen();
  };

  const browseHintGiven = useRef(false);
  const toggleSpeakMode = () => {
    const next = !speakMode;
    setSpeakMode(next);
    track('conversation', 'mode_toggle', { metadata: { mode: next ? 'voice' : 'browse' } });
    if (!next) {
      stopSpeaking();
      // First time into browse mode, tell the user how to navigate by heading.
      if (!browseHintGiven.current) {
        browseHintGiven.current = true;
        speak(
          'Browse mode. The menu is organized by category, like starters, mains, and desserts. Swipe to a category and double tap to open it, then swipe through its dishes. Double tap the category again to close it.',
          profile.ttsVoice,
        );
      }
      // Browse mode: land on the menu heading so VoiceOver starts at content
      setTimeout(() => menuHeadingRef.current?.focus(), 50);
    } else {
      // Voice mode: land on the action button ready to speak
      setTimeout(() => actionButtonRef.current?.focus(), 50);
    }
  };

  const displayText = liveText || latestAssistant;
  const indicator = indicatorFor(phase);
  const conversationSummary =
    latestUser && displayText
      ? `Latest exchange. You said: ${latestUser}. MenuVoice said: ${displayText}`
      : displayText
        ? `MenuVoice said: ${displayText}`
        : latestUser
          ? `You said: ${latestUser}`
          : 'No conversation yet.';

  // Single action whose label and handler derive from the current phase.
  const actionConfig = (() => {
    switch (phase) {
      case 'speaking':
        return {
          label: 'Interrupt and talk',
          hint: 'Stop MenuVoice and start speaking',
          unavailable: false,
          onClick: interruptAndListen,
        };
      case 'idle':
        return {
          label: 'Tap to talk',
          hint: 'Start speaking to MenuVoice',
          unavailable: false,
          onClick: () => startMic(),
        };
      case 'recording':
        return {
          label: 'Done talking',
          hint: 'Send what you just said',
          unavailable: false,
          onClick: () => speechManagerRef.current?.submitNow(),
        };
      case 'thinking':
      case 'transcribing':
        return {
          label: 'One moment...',
          hint: '',
          unavailable: true,
          onClick: () => {},
        };
      case 'error':
        return {
          label: 'Try again',
          hint: '',
          unavailable: false,
          onClick: () => { setErrorMsg(''); startMic(); },
        };
    }
  })();

  return (
    <Screen>
      <section
        className="conversation-layout"
        onClick={onConversationSurfaceClick}
        aria-label={phase === 'speaking' ? 'MenuVoice is speaking. Tap empty space to interrupt.' : undefined}
      >
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
        className={`phase-indicator phase-${phaseClass(phase)}`}
      >
        <span className="phase-dot" aria-hidden="true" />
        {indicator.label}
      </div>

      {/* Latest exchange — a bounded conversation region. Each message is its
          own bubble in a vertical stack with gaps, so bubbles never overlap each
          other or the controls, no matter how long a reply runs. */}
      <p
        className="sr-only"
        aria-live={phase === 'recording' ? 'off' : 'polite'}
        aria-atomic="true"
      >
        {conversationSummary}
      </p>
      <section className="convo-area" aria-hidden="true">
        {/* "You said" — live because the app does not speak user words back */}
        <div>
          {latestUser && (
            <div className="turn turn-user">
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
        {!latestUser && !displayText && (
          <p className="body" style={{ margin: 0, color: 'var(--text-muted)' }}>
            Your conversation will appear here.
          </p>
        )}
      </section>

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
        onClick={() => {
          if (actionConfig.unavailable) return;
          actionConfig.onClick();
        }}
        aria-disabled={actionConfig.unavailable}
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
        label={saving ? 'Saving...' : 'Done'}
        hint="Return to the home screen"
        onClick={finish}
        disabled={saving}
      />

      {/* Semantic menu — VoiceOver heading rotor: h1 restaurant → h2 category → h3 item */}
      <MenuDocument menu={menu} headingRef={menuHeadingRef} />
      </section>
    </Screen>
  );
}

function indicatorFor(phase: Phase): { label: string } {
  switch (phase) {
    case 'speaking':     return { label: 'MenuVoice is speaking...' };
    case 'idle':         return { label: 'Your turn. Tap to talk' };
    case 'recording':    return { label: 'Listening. Tap Done talking when finished' };
    case 'transcribing': return { label: 'Hearing you...' };
    case 'thinking':     return { label: 'Thinking...' };
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
