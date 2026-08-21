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
import { ChatTurn, DiningHistoryEntry, ParsedMenu } from '../types';
import { useProfile } from '../state/ProfileContext';
import { usePause } from '../state/PauseContext';
import { speak, stopSpeaking, createStreamingSpeech, unlockAudio } from '../lib/speech';
import {
  SpeechManager,
  isSpeechRecognitionSupported,
} from '../lib/speechRecognition';
import { buildOpeningLine, chatReplyStream, extractSessionLearnings, hasApiKey } from '../lib/openai';
import { DEMO_RESTAURANT_NAME } from '../lib/demoMenu';
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
import { menuStats } from '../lib/storage';
import { analyzeItemAllergens, allergenAlertText, dishSpokenLabel } from '../lib/allergens';
import { friendlyError } from '../lib/errors';
import {
  provenanceSummary,
  provenanceOpeningNote,
  locationAnswer,
  completenessAnswer,
  checkedPhrase,
} from '../lib/provenance';

type Phase = 'speaking' | 'idle' | 'recording' | 'transcribing' | 'thinking' | 'error';

const EXIT_PHRASES = [
  'go home', 'go back', 'exit', 'quit', 'i am done', "i'm done", 'all done', 'finished',
  'end conversation', 'goodbye', 'bye', 'that is all', "that's all",
];

const REPEAT_PHRASES = [
  'repeat that', 'say that again', 'what did you say', 'say it again', 'pardon', 'come again',
];

type ProvenanceIntent = 'source' | 'location' | 'freshness' | 'completeness';

// Map a spoken question to a provenance intent. Order matters: more specific
// intents (location, freshness, completeness) are checked before the general
// "where did this come from" source summary.
function matchProvenanceIntent(t: string): ProvenanceIntent | null {
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));
  if (has('correct location', 'right location', 'which location', 'what location', 'is this the right place', 'right branch', 'which branch'))
    return 'location';
  if (has('when was this menu', 'when was it checked', 'how current', 'how old', 'how recent', 'when did you check', 'up to date', 'how fresh'))
    return 'freshness';
  if (has('is this menu complete', 'is this complete', 'is the menu complete', 'is it complete', 'whole menu', 'full menu', 'anything missing', 'is anything missing'))
    return 'completeness';
  if (has('where did this menu come from', 'where did this come from', 'where is this from', 'where did you get', 'what is the source', 'is this official', 'is this the official', 'is this third party', 'is this third-party'))
    return 'source';
  return null;
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

  // Every dish is shown. We do NOT hide anything. For each dish we only look for
  // the guest's OWN listed allergens (blockedBy); a match becomes a prominent
  // alert at the top of the dish. Allergens the guest did not list are ignored,
  // so dishes are not cluttered with warnings that are not relevant to them.
  const categories = menu.categories.map((cat) => ({
    name: cat.name,
    items: cat.items.map((item) => ({ item, own: analyzeItemAllergens(item, allergies).blockedBy })),
  }));
  const alertCount = categories.reduce(
    (n, cat) => n + cat.items.filter(({ own }) => own.length > 0).length,
    0,
  );

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
          {alertCount > 0
            ? `${alertCount} dish${alertCount === 1 ? '' : 'es'} may contain your allergens (${allergies.join(', ')}). Each is shown with an alert. Always confirm with the restaurant.`
            : `Watching for your allergens: ${allergies.join(', ')}. Nothing on this menu appears to contain them, but always confirm with the restaurant.`}
        </p>
      )}
      {categories.map((cat) => {
        const open = !!openCategories[cat.name];
        const panelId = `category-panel-${cat.name.replace(/\s+/g, '-').toLowerCase()}`;
        const count = `${cat.items.length} item${cat.items.length === 1 ? '' : 's'}`;
        const catAlerts = cat.items.filter(({ own }) => own.length > 0).length;
        return (
          <section key={cat.name} style={{ marginBottom: 12 }}>
            <button
              className="btn btn-secondary browse-category-toggle"
              onClick={() => toggleCategory(cat.name)}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${cat.name}, ${count}${catAlerts > 0 ? `, ${catAlerts} with an allergy alert` : ''}. ${open ? 'Open. Activate to hide dishes.' : 'Activate to show dishes.'}`}
              style={{ minHeight: 64, width: '100%', justifyContent: 'space-between', textAlign: 'left' }}
            >
              <span aria-hidden="true">{cat.name}</span>
              <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 400, fontSize: '0.8em' }}>
                {catAlerts > 0 && <span className="browse-alert-count">{catAlerts} alert{catAlerts === 1 ? '' : 's'}</span>}
                {count} {open ? '▾' : '▸'}
              </span>
            </button>
            {open && (
              <div
                id={panelId}
                style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, marginBottom: 8 }}
              >
                {cat.items.map(({ item, own }) => (
                  <article
                    key={item.name}
                    className={`browse-item${own.length > 0 ? ' browse-item-alert' : ''}`}
                  >
                    {/* Single rotor stop: the whole dish, spoken from aria-label.
                        The name comes first, followed immediately by any allergy
                        alert. Visible content is hidden from assistive tech so it
                        is not read twice. */}
                    {own.length > 0 && (
                      <p className="allergen-alert" aria-hidden="true">
                        {allergenAlertText(own)}
                      </p>
                    )}
                    <h3 className="browse-item-name" aria-label={dishSpokenLabel(item, own)}>
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
                  </article>
                ))}
              </div>
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
  const { paused, pause, resume, registerStopListening } = usePause();
  const { menu, restaurantName, provenance } = route;

  // Voice (conversation) mode is simply the inverse of the global pause state:
  // not paused = Conversation Mode (mic on, Meet My Menu AI speaks);
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
      // Prefer the structured provenance note (source, location scope, freshness,
      // completeness). Fall back to the older generic note only when we have no
      // provenance, so nothing regresses for menus saved before this feature.
      const onlineNote = provenance
        ? provenanceOpeningNote(provenance)
        : route.source === 'url'
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
      // Resumed: pick up where we left off — re-speak the last thing Meet My Menu AI
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

    // Provenance voice controls — answered locally from the source metadata, not
    // the menu LLM, so the answer is grounded in what we actually verified.
    const provIntent = matchProvenanceIntent(t);
    if (provIntent) {
      track('ask', 'provenance_query', { content: { text: t }, metadata: { intent: provIntent } });
      let answer = '';
      if (provIntent === 'source') answer = provenanceSummary(provenance, restaurantName);
      else if (provIntent === 'location') answer = locationAnswer(provenance);
      else if (provIntent === 'freshness') answer = `${checkedPhrase(provenance?.checkedAt)}.`;
      else answer = completenessAnswer(provenance);
      await sayReply(answer);
      return;
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
        }, provenance);
        await streamer.finish();
      } catch (e: any) {
        earconThinkingStop();
        earconError();
        try { navigator.vibrate?.([200, 50, 200]); } catch {}
        const msg = friendlyError(e, "Something went wrong. Let's try that again.");
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
        }, provenance);
      } catch (e: any) {
        earconThinkingStop();
        earconError();
        const msg = friendlyError(e, "Something went wrong. Let's try that again.");
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
    // Practicing with the Demo Menu is not a real dining decision — never
    // learn preferences or dining history from it.
    const isDemo = restaurantName === DEMO_RESTAURANT_NAME;
    if (hasUser && hasApiKey() && !isDemo) {
      setSaving(true);
      try {
        const learn = await extractSessionLearnings(turns);
        const hasLearning = learn.orders.length > 0 || learn.likes.length > 0 || learn.dislikes.length > 0;
        const stats = menuStats(menu);
        const diningHistory: DiningHistoryEntry[] = hasLearning
          ? [
              {
                id: `dh-${Date.now()}`,
                learnedAt: new Date().toISOString(),
                restaurantName,
                location: provenance?.confirmedLocation,
                sourceType: provenance?.sourceType,
                orders: learn.orders,
                likes: learn.likes,
                dislikes: learn.dislikes,
                turnCount: turns.length,
                menuItemCount: stats.itemCount,
              },
              ...(profile.diningHistory ?? []),
            ].slice(0, 100)
          : (profile.diningHistory ?? []);
        await update({
          pastOrders: mergeUnique(profile.pastOrders, learn.orders),
          cuisinesLiked: mergeUnique(profile.cuisinesLiked, learn.likes),
          dislikes: mergeUnique(profile.dislikes, learn.dislikes),
          diningHistory,
        });
        if (hasLearning) {
          track('learnings', 'dining_history_saved', {
            content: {
              restaurantName,
              orders: learn.orders,
              cuisines_liked: learn.likes,
              dislikes: learn.dislikes,
            },
            metadata: {
              location: provenance?.confirmedLocation,
              sourceType: provenance?.sourceType,
              turn_count: turns.length,
              menu_item_count: stats.itemCount,
            },
          });
        }
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
      // any Meet My Menu AI audio and the mic immediately; the conversation/session
      // state stays intact in the background. We intentionally do NOT speak a
      // hint here so Meet My Menu AI never talks over VoiceOver while browsing — the
      // pause status is announced through the screen reader's live region.
      track('conversation', 'mode_toggle', { metadata: { mode: 'browse' } });
      pause(
        'Browse Menu. Voice is paused so your screen reader can read without interruption. ' +
          'Your conversation is saved. Activate Resume Voice Conversation when you are ready.',
      );
      // Land on the menu heading so VoiceOver starts at the content and make
      // the same destination visible for low-vision users. Respect reduced
      // motion instead of forcing a smooth animated scroll.
      setTimeout(() => {
        const heading = menuHeadingRef.current;
        if (!heading) return;
        heading.focus({ preventScroll: true });
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        heading.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }, 50);
    } else {
      // Returning to Conversation Mode — resume() reopens the mic via the
      // paused effect and restores voice interaction with the saved session.
      track('conversation', 'mode_toggle', { metadata: { mode: 'voice' } });
      resume('Conversation Mode. The microphone is on. Talk with Meet My Menu AI.');
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
      ? `Latest exchange. You said: ${latestUser}. Meet My Menu AI said: ${displayText}`
      : displayText
        ? `Meet My Menu AI said: ${displayText}`
        : latestUser
          ? `You said: ${latestUser}`
          : 'No conversation yet.';

  // Single action whose label and handler derive from the current phase.
  const actionConfig = (() => {
    switch (phase) {
      case 'speaking':
        return {
          label: 'Interrupt and talk',
          hint: 'Stop Meet My Menu AI and start speaking',
          unavailable: false,
          onClick: interruptAndListen,
        };
      case 'idle':
        return {
          label: 'Tap to talk',
          hint: 'Start speaking to Meet My Menu AI',
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
        aria-label={phase === 'speaking' ? 'Meet My Menu AI is speaking. Tap empty space to interrupt.' : undefined}
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
            Some menu sections may be missing.
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

      {/* Voice made visible — bars pulse amber while Meet My Menu AI speaks, green
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
            <div className="turn-speaker">Meet My Menu AI</div>
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
            ? 'Conversation Mode is on. The microphone is active and Meet My Menu AI talks with you. Activate to switch to Browse Menu, which pauses voice and stays silent.'
            : 'Browse Menu is on. Voice is paused and silent so your screen reader can read the menu. Activate Resume Voice Conversation to talk with Meet My Menu AI again.'
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
          {speakMode ? 'Talk with Meet My Menu AI. Tap for Browse Menu.' : 'Browsing silently. Tap to talk again.'}
        </span>
      </button>

      {/* Short guidance so screen-reader users know their options here: this is
          the ONE screen where Meet My Menu AI speaks, VoiceOver is optional in it,
          and the Pause Voice button is the global off switch. */}
      <p role="note" className="body" style={{ fontSize: 15, color: 'var(--text-secondary)', margin: 0 }}>
        Talk naturally, or use your screen reader. Pause Voice & Mic stops both.
      </p>

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
    case 'speaking':     return { label: 'Meet My Menu AI is speaking...' };
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
