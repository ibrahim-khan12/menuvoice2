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
import { speak, stopSpeaking, createStreamingSpeech, unlockAudio } from '../lib/speech';
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
import { analyzeItemAllergens } from '../lib/allergens';

type Phase = 'speaking' | 'idle' | 'recording' | 'transcribing' | 'thinking' | 'error';

const EXIT_PHRASES = [
  'go home', 'go back', 'exit', 'quit', 'i am done', "i'm done", 'all done', 'finished',
  'end conversation', 'goodbye', 'bye', 'that is all', "that's all",
];

const REPEAT_PHRASES = [
  'repeat that', 'say that again', 'what did you say', 'say it again', 'pardon', 'come again',
];

// One dish heading's spoken text: name, price, description, and ingredients
// folded into a single natural line. This is the dish's accessible name, so a
// VoiceOver user gets the whole dish in ONE rotor stop. Price is read as part of
// the dish, never as its own stop.
function dishLabel(
  item: ParsedMenu['categories'][number]['items'][number],
  otherAllergens: string[] = [],
): string {
  let label = item.name;
  if (item.price) label += `, ${item.price}`;
  if (item.description) label += `. ${item.description}`;
  if (item.ingredients && item.ingredients.length > 0) {
    label += `. Ingredients: ${item.ingredients.join(', ')}`;
  }
  if (otherAllergens.length > 0) {
    // Read the allergen warning last, as part of the same single rotor stop.
    label += `. Allergen warning. This dish contains ${otherAllergens.join(', ')}. Please confirm with the restaurant.`;
  }
  return label;
}

// Semantic menu document — categories are COLLAPSED by default so VoiceOver does
// not read through every dish on arrival. Each category is a toggle button; its
// dishes are only rendered into the DOM when that category is expanded, so they
// are silent until the user chooses to open a section.
//
// When a category is open:
//   h2 "Full menu" → button category (with item count, aria-expanded) → h3 dish.
// Each dish is a SINGLE h3 stop whose accessible name (aria-label) reads the
// whole dish. Price, description, and ingredients are visible for sighted and
// low-vision users but aria-hidden, so they are NOT separate headings or extra
// rotor stops.
function MenuDocument({
  menu,
  allergies,
  headingRef,
}: {
  menu: ParsedMenu;
  allergies: string[];
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

  // Filter each category against the guest's allergies: dishes containing one of
  // their allergens are removed entirely. Surviving dishes keep any OTHER
  // allergens for the disclaimer. Categories left with no safe dishes are hidden.
  const categories = menu.categories
    .map((cat) => ({
      name: cat.name,
      items: cat.items
        .map((item) => ({ item, info: analyzeItemAllergens(item, allergies) }))
        .filter(({ info }) => !info.blocked),
    }))
    .filter((cat) => cat.items.length > 0);

  return (
    <section aria-label="Menu by category. Open a category to read its dishes." style={{ marginTop: 24 }}>
      <h2
        ref={headingRef}
        tabIndex={-1}
        style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}
      >
        Menu categories
      </h2>
      {allergies.length > 0 && (
        <p className="body" style={{ marginTop: 0, marginBottom: 12, color: 'var(--text-secondary)' }}>
          Dishes containing your allergens ({allergies.join(', ')}) are hidden. Always confirm with the restaurant.
        </p>
      )}
      {categories.map((cat) => {
        const open = !!openCategories[cat.name];
        const panelId = `category-panel-${cat.name.replace(/\s+/g, '-').toLowerCase()}`;
        const count = `${cat.items.length} item${cat.items.length === 1 ? '' : 's'}`;
        return (
          <section key={cat.name} style={{ marginBottom: 12 }}>
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
            {open && (
              <div
                id={panelId}
                style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, marginBottom: 8 }}
              >
                {cat.items.map(({ item, info }) => (
                  <article
                    key={item.name}
                    className={`browse-item${info.otherAllergens.length > 0 ? ' browse-item-allergen' : ''}`}
                  >
                    {/* Single rotor stop: the whole dish, spoken from aria-label.
                        Visible content below is aria-hidden so nothing is read
                        twice and nothing extra lands in the heading rotor. */}
                    <h3 className="browse-item-name" aria-label={dishLabel(item, info.otherAllergens)}>
                      <span aria-hidden="true">{item.name}</span>
                      {item.price && (
                        <span className="browse-item-price" aria-hidden="true">{' '}{item.price}</span>
                      )}
                    </h3>
                    {item.description && (
                      <p className="browse-item-desc" aria-hidden="true">{item.description}</p>
                    )}
                    {item.ingredients && item.ingredients.length > 0 && (
                      <p className="browse-item-desc" aria-hidden="true">
                        <span className="browse-item-sub">Ingredients: </span>
                        {item.ingredients.join(', ')}
                      </p>
                    )}
                    {info.otherAllergens.length > 0 && (
                      <p className="allergen-disclaimer" aria-hidden="true">
                        ⚠ Contains {info.otherAllergens.join(', ')}. Known allergen. Confirm with the restaurant.
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        );
      })}
      {categories.length === 0 && (
        <p className="body" role="note" style={{ marginTop: 8 }}>
          Every dish on this menu contains one of your listed allergens, so none are shown. Please ask the restaurant about safe options.
        </p>
      )}
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
  const { paused, pause, resume, registerStopListening } = usePause();
  const { menu, restaurantName } = route;

  // Voice (conversation) mode is simply the inverse of the global pause state:
  // not paused = Conversation Mode (mic on, MenuVoice speaks);
  // paused     = Browse Menu (silent, screen reader only). This keeps the
  // floating Pause Voice button and the mode toggle in perfect sync.
  const speakMode = !paused;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [latestUser, setLatestUser] = useState('');
  const [latestAssistant, setLatestAssistant] = useState('');
  const [liveText, setLiveText] = useState('');
  const [phase, setPhase] = useState<Phase>('speaking');
  const [errorMsg, setErrorMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const started = useRef(false);
  const speechManagerRef = useRef<SpeechManager | null>(null);
  const processUtteranceRef = useRef<(text: string) => Promise<void>>(async () => {});
  const startMicRef = useRef<() => Promise<void>>(async () => {});
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // speakMode tracks the inverse of paused; read pausedRef in async closures.
  const speakModeRef = { get current() { return !pausedRef.current; } };
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
      // Stay silent if we arrived already paused (e.g. paused on the capture
      // screen). Resume Voice will then speak this opening line.
      if (!pausedRef.current) {
        setPhase('speaking');
        earconSpeak();
        // Stream the opening sentence-by-sentence so the first sentence starts
        // playing while the rest is still synthesizing — much faster to first
        // audio than synthesizing the whole opening line up front.
        const opener = createStreamingSpeech(profile.ttsVoice);
        opener.push(opening);
        await opener.finish();
      }
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

  // React to global pause/resume. Pausing fully stops audio + mic; resuming
  // reopens the mic so the saved conversation continues hands-free. The opening
  // effect handles the very first mic open, so we only act on a real transition.
  const prevPausedRef = useRef(paused);
  useEffect(() => {
    const was = prevPausedRef.current;
    prevPausedRef.current = paused;
    if (paused) {
      speechManagerRef.current?.destroy();
      speechManagerRef.current = null;
      stopSpeaking();
      earconThinkingStop();
      setPhase((current) => (current === 'recording' || current === 'speaking' ? 'idle' : current));
    } else if (was && started.current) {
      // Resumed: pick up where we left off — re-speak the last thing MenuVoice
      // said, then reopen the mic so the saved conversation continues.
      (async () => {
        const resumeText = latestAssistant;
        if (resumeText) {
          setPhase('speaking');
          earconSpeak();
          await speak(resumeText, profile.ttsVoice);
        }
        if (pausedRef.current) {
          setPhase('idle');
          return;
        }
        await startMicRef.current();
      })();
    }
    // latestAssistant intentionally omitted from deps: this must run only on a
    // pause/resume transition, not every time the assistant text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    unlockAudio();
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

  const toggleSpeakMode = () => {
    unlockAudio();
    if (speakMode) {
      // Entering Browse Menu — pause the whole voice experience. pause() stops
      // any MenuVoice audio and the mic immediately; the conversation/session
      // state stays intact in the background. We intentionally do NOT speak a
      // hint here so MenuVoice never talks over VoiceOver while browsing — the
      // pause status is announced through the screen reader's live region.
      track('conversation', 'mode_toggle', { metadata: { mode: 'browse' } });
      pause(
        'Browse Menu. Voice is paused so your screen reader can read without interruption. ' +
          'Your conversation is saved. Activate Resume Voice Conversation when you are ready.',
      );
      // Land on the menu heading so VoiceOver starts at the content.
      setTimeout(() => menuHeadingRef.current?.focus(), 50);
    } else {
      // Returning to Conversation Mode — resume() reopens the mic via the
      // paused effect and restores voice interaction with the saved session.
      track('conversation', 'mode_toggle', { metadata: { mode: 'voice' } });
      resume('Conversation Mode. The microphone is on. Talk with MenuVoice.');
      setTimeout(() => actionButtonRef.current?.focus(), 50);
    }
  };

  const displayText = liveText || latestAssistant;
  const indicator = indicatorFor(phase);
  // Voice visualizer — decorative; mirrors the spoken/heard state in color + motion.
  const vizActive = phase === 'speaking' || phase === 'recording';
  const vizColor =
    phase === 'speaking' ? 'var(--accent)'
      : phase === 'recording' || phase === 'idle' ? 'var(--success)'
      : phase === 'error' ? 'var(--danger)'
      : 'var(--text-muted)';
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

      {/* Voice made visible — bars pulse amber while MenuVoice speaks, green
          while listening. Decorative only; the spoken state is announced below. */}
      <div className={`voice-viz${vizActive ? ' voice-viz--active' : ''}`} style={{ color: vizColor }} aria-hidden="true">
        <span className="voice-viz__bar" />
        <span className="voice-viz__bar" />
        <span className="voice-viz__bar" />
        <span className="voice-viz__bar" />
        <span className="voice-viz__bar" />
      </div>

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
          // Real user gesture: unlock audio playback so replies after the mic's
          // silence auto-submit (which has no gesture) can still be spoken.
          unlockAudio();
          if (actionConfig.unavailable) return;
          actionConfig.onClick();
        }}
        aria-disabled={actionConfig.unavailable}
        aria-label={actionConfig.hint ? `${actionConfig.label}. ${actionConfig.hint}` : actionConfig.label}
        style={{ minHeight: 110 }}
      >
        {actionConfig.label}
      </button>

      {/* Mode switch — label and hint spell out exactly what each mode does and
          what activating will change, so the choice is clear before tapping. */}
      <button
        onClick={toggleSpeakMode}
        aria-pressed={speakMode}
        aria-label={
          speakMode
            ? 'Conversation Mode is on. The microphone is active and MenuVoice talks with you. Activate to switch to Browse Menu, which pauses voice and stays silent.'
            : 'Browse Menu is on. Voice is paused and silent so your screen reader can read the menu. Activate Resume Voice Conversation to talk with MenuVoice again.'
        }
        className="btn btn-secondary"
        style={{
          minHeight: 72,
          flexDirection: 'column',
          gap: 4,
          border: `2px solid ${speakMode ? 'var(--accent)' : 'var(--border)'}`,
          background: speakMode ? 'var(--surface-high)' : 'var(--surface)',
          color: speakMode ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        <span aria-hidden="true" style={{ fontWeight: 700 }}>
          {speakMode ? 'Conversation Mode' : 'Resume Voice Conversation'}
        </span>
        <span aria-hidden="true" style={{ fontSize: '0.8em', fontWeight: 400 }}>
          {speakMode ? 'Talk with MenuVoice. Tap for Browse Menu.' : 'Browsing silently. Tap to talk again.'}
        </span>
      </button>

      <SecondaryButton
        label={saving ? 'Saving...' : 'Done'}
        hint="Return to the home screen"
        onClick={finish}
        disabled={saving}
      />

      {/* Semantic menu — VoiceOver heading rotor: h1 restaurant → h2 category → h3 item */}
      <MenuDocument menu={menu} allergies={profile.allergies} headingRef={menuHeadingRef} />
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
