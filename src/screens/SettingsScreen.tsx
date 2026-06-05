// Settings: hide prices, edit allergies/preferences, choose TTS voice.
// Voice: on mount, speaks current settings summary. Supports voice commands to
// toggle prices, change voice, update name/spice/dislikes, clear allergies, save, and go back.

import { useEffect, useState } from 'react';
import { Screen, Title, Body, Heading, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { useProfile } from '../state/ProfileContext';
import { splitList } from '../util';
import { useVoiceNav } from '../hooks/useVoiceNav';
import { startRecording, stopRecording, requestMicPermission } from '../lib/recorder';
import { transcribeAudio } from '../lib/openai';
import { speak } from '../lib/speech';

const VOICES = ['shimmer', 'nova', 'alloy', 'echo', 'fable', 'onyx'];
const SPICE_LEVELS = ['none', 'mild', 'medium', 'hot'] as const;
type SpiceLevel = typeof SPICE_LEVELS[number];
type RecState = 'idle' | 'recording' | 'working';

function extractAfterKeyword(transcript: string, keywords: string[]): string {
  const t = transcript.toLowerCase();
  for (const kw of keywords.sort((a, b) => b.length - a.length)) {
    const idx = t.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      return transcript.slice(idx + kw.length).replace(/^[\s,]+/, '').replace(/[.!?]+$/, '').trim();
    }
  }
  return '';
}

export default function SettingsScreen({ goBack, navigate }: ScreenProps) {
  const { profile, update, reset } = useProfile();
  const [allergies, setAllergies] = useState(profile.allergies.join(', '));
  const [cuisines, setCuisines] = useState(profile.cuisinesLiked.join(', '));
  const [saved, setSaved] = useState(false);
  const [nameVal, setNameVal] = useState(profile.name);
  const [nameRec, setNameRec] = useState<RecState>('idle');
  const [dislikes, setDislikes] = useState<string[]>(profile.dislikes);
  const [newDislike, setNewDislike] = useState('');
  const [dislikeRec, setDislikeRec] = useState<RecState>('idle');

  const persist = async () => {
    await update({ allergies: splitList(allergies), cuisinesLiked: splitList(cuisines) });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveName = async (val: string) => {
    const trimmed = val.trim();
    if (!trimmed || trimmed === profile.name) return;
    await update({ name: trimmed });
    speak(`Name updated to ${trimmed}.`);
  };

  const speakName = async () => {
    if (nameRec !== 'idle') return;
    const ok = await requestMicPermission();
    if (!ok) { speak('Microphone access needed. Allow it and try again.'); return; }
    try {
      await startRecording();
      setNameRec('recording');
    } catch {
      speak('Could not start microphone. Try typing instead.');
    }
  };

  const stopSpeakName = async () => {
    if (nameRec !== 'recording') return;
    setNameRec('working');
    let blob: Blob | null = null;
    try { blob = await stopRecording(); } catch {}
    if (!blob) { setNameRec('idle'); return; }
    try {
      const text = await transcribeAudio(blob);
      if (text) {
        const cleaned = text.replace(/^(my name is|call me|i'?m|i am|it'?s?)\s+/i, '').replace(/[.!?]+$/, '').trim();
        const name = cleaned || text.replace(/[.!?]+$/, '').trim();
        if (name) {
          setNameVal(name);
          await update({ name });
          speak(`Name updated to ${name}.`);
        }
      }
    } catch {}
    setNameRec('idle');
  };

  const speakDislike = async () => {
    if (dislikeRec !== 'idle') return;
    const ok = await requestMicPermission();
    if (!ok) { speak('Microphone access needed. Allow it and try again.'); return; }
    try {
      await startRecording();
      setDislikeRec('recording');
    } catch {
      speak('Could not start microphone. Try typing instead.');
    }
  };

  const stopSpeakDislike = async () => {
    if (dislikeRec !== 'recording') return;
    setDislikeRec('working');
    let blob: Blob | null = null;
    try { blob = await stopRecording(); } catch {}
    if (!blob) { setDislikeRec('idle'); return; }
    try {
      const text = await transcribeAudio(blob);
      if (text) {
        const raw = text.replace(/^(i don'?t like|add dislike|dislike|i hate|hate)\s+/i, '').replace(/[.!?]+$/, '').trim();
        const item = raw || text.replace(/[.!?]+$/, '').trim();
        if (item) {
          const next = [...dislikes.filter((d) => d.toLowerCase() !== item.toLowerCase()), item];
          setDislikes(next);
          setNewDislike('');
          await update({ dislikes: next });
          speak(`Added ${item} to your dislikes.`);
        }
      }
    } catch {}
    setDislikeRec('idle');
  };

  const { phase, announce, listen, finish } = useVoiceNav({
    voice: profile.ttsVoice,
    commands: [
      { id: 'prices_on',      keywords: ['hide prices', 'hide the price', 'turn on hide', 'prices off', 'price off'] },
      { id: 'prices_off',     keywords: ['show prices', 'show the price', 'turn off hide', 'prices on', 'price on', 'display price'] },
      { id: 'voice',          keywords: ['change voice', 'switch voice', 'voice to', 'use voice', 'shimmer', 'nova', 'alloy', 'echo', 'fable', 'onyx'] },
      { id: 'name',           keywords: ['name', 'call me', 'my name'] },
      { id: 'dislike',        keywords: ['dislike', "don't like", 'add dislike', 'hate'] },
      { id: 'spice',          keywords: ['spice', 'mild', 'medium', 'hot', 'none', 'tolerance'] },
      { id: 'add_allergy',    keywords: ["i'm allergic to", 'i am allergic', 'add allergy', 'add allergen', 'allergic to'] },
      { id: 'remove_allergy', keywords: ['remove allergy', 'delete allergy', 'no longer allergic', 'remove allergen', 'not allergic'] },
      { id: 'clear_allergies',keywords: ['clear allergies', 'remove all allergies', 'no allergies', 'delete all allergies'] },
      { id: 'remove',         keywords: ['remove', 'delete dislike'] },
      { id: 'help',           keywords: ['what can i say', 'help', 'options', 'commands', 'what do i say'] },
      { id: 'save',           keywords: ['save', 'done', 'confirm', 'apply'] },
      { id: 'back',           keywords: ['back', 'go back', 'close', 'cancel', 'home', 'exit'] },
    ],
    onCommand: async (id, transcript) => {
      if (id === 'prices_on') {
        await update({ hidePrices: true });
        await announce('Prices are now hidden. Say "show prices" to undo, or "save" to save.');
        return;
      }
      if (id === 'prices_off') {
        await update({ hidePrices: false });
        await announce('Prices will be shown. Say "save" to save, or "back" to go back.');
        return;
      }
      if (id === 'voice') {
        const t = transcript.toLowerCase();
        const picked = VOICES.find((v) => t.includes(v));
        if (picked) {
          await update({ ttsVoice: picked });
          await announce(`Voice changed to ${picked}. How does this sound? Say "save" to keep it.`);
        } else {
          await announce(`Available voices are: ${VOICES.join(', ')}. Say "change voice to" and the name.`);
        }
        return;
      }
      if (id === 'name') {
        await announce('Tap the mic button next to your name to speak your new name.');
        return;
      }
      if (id === 'dislike') {
        const item = extractAfterKeyword(transcript, ["don't like", 'add dislike', 'dislike', 'hate']);
        if (item) {
          const next = [...dislikes.filter((d) => d.toLowerCase() !== item.toLowerCase()), item];
          setDislikes(next);
          await update({ dislikes: next });
          await announce(`Added ${item} to your dislikes.`);
        } else {
          await announce("Tap the mic in the Dislikes section to speak what you'd like to add.");
        }
        return;
      }
      if (id === 'spice') {
        const t = transcript.toLowerCase();
        const level = SPICE_LEVELS.find((l) => t.includes(l));
        if (level) {
          await update({ spiceTolerance: level });
          await announce(`Spice tolerance set to ${level}.`);
        } else {
          await announce('Spice levels are none, mild, medium, or hot. Say which one you prefer.');
        }
        return;
      }
      if (id === 'add_allergy') {
        const allergen = extractAfterKeyword(transcript, ["i'm allergic to", 'i am allergic to', 'add allergy', 'allergic to', 'add allergen']);
        if (allergen) {
          const next = [...profile.allergies.filter((a) => a.toLowerCase() !== allergen.toLowerCase()), allergen];
          await update({ allergies: next });
          setAllergies(next.join(', '));
          await announce(`Added ${allergen} to your allergies. I'll always warn you before any dish that contains it.`);
        } else {
          await announce('Say "add allergy" followed by what you\'re allergic to. For example: "add allergy shellfish".');
        }
        return;
      }
      if (id === 'remove_allergy') {
        const allergen = extractAfterKeyword(transcript, ['remove allergy', 'delete allergy', 'no longer allergic to', 'not allergic to', 'remove allergen']);
        if (allergen && profile.allergies.length) {
          const next = profile.allergies.filter((a) => !a.toLowerCase().includes(allergen.toLowerCase()));
          if (next.length < profile.allergies.length) {
            await update({ allergies: next });
            setAllergies(next.join(', '));
            await announce(`Removed ${allergen} from your allergies.`);
          } else {
            await announce(`I didn't find ${allergen} in your allergy list. Current allergies: ${profile.allergies.join(', ') || 'none'}.`);
          }
        } else {
          await announce(profile.allergies.length ? `Your allergies are: ${profile.allergies.join(', ')}. Say "remove allergy" followed by the one to remove.` : 'You have no allergies on file.');
        }
        return;
      }
      if (id === 'clear_allergies') {
        await update({ allergies: [] });
        setAllergies('');
        await announce('All allergies cleared.');
        return;
      }
      if (id === 'remove') {
        const item = extractAfterKeyword(transcript, ['delete dislike', 'remove']);
        if (item && dislikes.length) {
          const match = dislikes.find((d) => d.toLowerCase().includes(item.toLowerCase()));
          if (match) {
            const next = dislikes.filter((d) => d !== match);
            setDislikes(next);
            await update({ dislikes: next });
            await announce(`Removed ${match} from your dislikes.`);
          } else {
            await announce(`I didn't find "${item}" in your dislikes. Current dislikes: ${dislikes.join(', ') || 'none'}.`);
          }
        } else {
          await announce(dislikes.length ? `Your dislikes are: ${dislikes.join(', ')}. Say "remove" followed by the item.` : 'You have no dislikes on file.');
        }
        return;
      }
      if (id === 'help') {
        await announce(
          `Voice commands: "hide prices" or "show prices". ` +
          `"Change voice to" followed by ${VOICES.join(', ')}. ` +
          `"My name" to update your name. ` +
          `"Spice" followed by none, mild, medium, or hot. ` +
          `"Dislike" followed by a food to add it. ` +
          `"Remove" followed by a dislike to remove it. ` +
          `"Add allergy" followed by what you're allergic to. ` +
          `"Remove allergy" followed by which one. ` +
          `"Save" to save changes. "Back" to return.`
        );
        return;
      }
      if (id === 'save') {
        await persist();
        await announce('Changes saved. Say "back" to return, or keep making changes.');
        return;
      }
      if (id === 'back') {
        goBack();
        return;
      }
    },
    onNoMatch: async (transcript) => {
      return `I didn't understand "${transcript.slice(0, 40)}". Say "help" for a list of commands.`;
    },
  });

  useEffect(() => {
    const priceState = profile.hidePrices ? 'hidden' : 'shown';
    announce(
      `Settings. Prices are currently ${priceState}. ` +
        `Voice is ${profile.ttsVoice}. Spice tolerance is ${profile.spiceTolerance}. ` +
        `Say "help" for all commands, or "back" to return.`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase === 'announcing' || phase === 'transcribing';
  const anyInlineMicBusy = nameRec !== 'idle' || dislikeRec !== 'idle';
  const micLabel =
    phase === 'recording'    ? 'Done speaking' :
    phase === 'transcribing' ? 'Hearing you…'  :
    phase === 'announcing'   ? 'Please wait…'  :
                               'Tap to speak a command';

  return (
    <Screen>
      <Title>Settings</Title>

      <Heading>Your name</Heading>
      <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
        <input
          className="input"
          type="text"
          value={nameVal}
          onChange={(e) => setNameVal(e.target.value)}
          onBlur={() => saveName(nameVal)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveName(nameVal); }}
          placeholder="First name"
          aria-label="Your name — tap mic to speak it"
          style={{ flex: 1, margin: 0 }}
        />
        <button
          onClick={nameRec === 'recording' ? stopSpeakName : speakName}
          disabled={nameRec === 'working' || busy}
          aria-label={nameRec === 'recording' ? 'Done speaking name' : 'Speak your name'}
          style={{
            minHeight: 64,
            minWidth: 64,
            borderRadius: 'var(--r-md)',
            border: `2px solid ${nameRec === 'recording' ? 'var(--success)' : 'var(--border)'}`,
            background: nameRec === 'recording' ? 'var(--success)' : 'var(--surface-high)',
            color: 'var(--text-primary)',
            fontSize: 22,
            cursor: 'pointer',
          }}
        >
          {nameRec === 'recording' ? 'Stop' : nameRec === 'working' ? '…' : 'Mic'}
        </button>
      </div>

      <Heading>Spice tolerance</Heading>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {SPICE_LEVELS.map((level) => {
          const active = profile.spiceTolerance === level;
          return (
            <button
              key={level}
              onClick={() => update({ spiceTolerance: level })}
              aria-label={`Spice ${level}${active ? ', selected' : ''}`}
              aria-pressed={active}
              style={{
                flex: 1,
                minHeight: 64,
                padding: '0 12px',
                borderRadius: 'var(--r-md)',
                border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--surface-high)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 16,
                fontWeight: 600,
                cursor: 'pointer',
                textTransform: 'capitalize',
              }}
            >
              {level}
            </button>
          );
        })}
      </div>

      <Heading>Foods you dislike</Heading>
      {dislikes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {dislikes.map((item) => (
            <div key={item} className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, fontSize: 16 }}>{item}</span>
              <button
                onClick={() => {
                  const next = dislikes.filter((d) => d !== item);
                  setDislikes(next);
                  update({ dislikes: next });
                }}
                aria-label={`Remove ${item} from dislikes`}
                className="btn-icon"
                style={{ color: 'var(--text-secondary)' }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
        <input
          className="input"
          type="text"
          value={newDislike}
          onChange={(e) => setNewDislike(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newDislike.trim()) {
              const trimmed = newDislike.trim();
              const next = [...dislikes.filter((d) => d.toLowerCase() !== trimmed.toLowerCase()), trimmed];
              setDislikes(next);
              setNewDislike('');
              update({ dislikes: next });
            }
          }}
          placeholder="Add a dislike (e.g. mushrooms)"
          aria-label="Add a dislike — tap mic to speak it"
          style={{ flex: 1, margin: 0 }}
        />
        <button
          onClick={dislikeRec === 'recording' ? stopSpeakDislike : speakDislike}
          disabled={dislikeRec === 'working' || busy}
          aria-label={dislikeRec === 'recording' ? 'Done speaking' : 'Speak a food to add to dislikes'}
          style={{
            minHeight: 64,
            minWidth: 64,
            borderRadius: 'var(--r-md)',
            border: `2px solid ${dislikeRec === 'recording' ? 'var(--success)' : 'var(--border)'}`,
            background: dislikeRec === 'recording' ? 'var(--success)' : 'var(--surface-high)',
            color: 'var(--text-primary)',
            fontSize: 22,
            cursor: 'pointer',
          }}
        >
          {dislikeRec === 'recording' ? 'Stop' : dislikeRec === 'working' ? '…' : 'Mic'}
        </button>
      </div>

      <label
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 18 }}>Hide prices</span>
        <input
          type="checkbox"
          checked={profile.hidePrices}
          onChange={(e) => update({ hidePrices: e.target.checked })}
          aria-label="Hide prices"
          style={{ width: 28, height: 28 }}
        />
      </label>

      <Heading>Allergies &amp; restrictions</Heading>
      <Body>Comma separated. I warn you about these before any dish.</Body>
      <input
        className="input"
        type="text"
        value={allergies}
        onChange={(e) => setAllergies(e.target.value)}
        placeholder="e.g. shellfish, peanuts"
        aria-label="Allergies, comma separated"
      />

      <Heading>Foods you love</Heading>
      <input
        className="input"
        type="text"
        value={cuisines}
        onChange={(e) => setCuisines(e.target.value)}
        placeholder="e.g. Thai, spicy, seafood"
        aria-label="Preferred foods, comma separated"
      />

      <Heading>Voice</Heading>
      <Body style={{ fontSize: 15, marginTop: -4 }}>
        Say "change voice to [name]" or tap one below.
      </Body>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {VOICES.map((v) => {
          const active = profile.ttsVoice === v;
          return (
            <button
              key={v}
              onClick={() => update({ ttsVoice: v })}
              aria-label={`Voice ${v}${active ? ', selected' : ''}`}
              aria-pressed={active}
              style={{
                minHeight: 64,
                minWidth: 80,
                padding: '0 16px',
                borderRadius: 'var(--r-md)',
                border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--surface-high)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 18,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {v}
            </button>
          );
        })}
      </div>

      <PrimaryButton
        label={micLabel}
        hint="Speak a settings command"
        onClick={phase === 'recording' ? finish : listen}
        disabled={busy || anyInlineMicBusy}
        style={{
          minHeight: 80,
          background: phase === 'recording' ? 'var(--success)' : undefined,
        }}
      />

      <PrimaryButton label={saved ? 'Saved' : 'Save changes'} onClick={persist} />
      <SecondaryButton label="Back" onClick={goBack} />
      <SecondaryButton
        label="Sign out"
        tone="danger"
        hint="Clear your account and return to the login screen"
        onClick={async () => { await reset(); navigate({ name: 'home' }); }}
      />
    </Screen>
  );
}
