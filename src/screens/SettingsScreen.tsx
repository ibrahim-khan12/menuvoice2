// Settings: hide prices, edit allergies/preferences, choose TTS voice.
// Voice nav removed — VoiceOver reads all controls.
// Inline mics (name, dislike) still use MediaRecorder for field-level input.

import { useEffect, useState } from 'react';
import { Screen, Title, Body, Heading, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { useProfile } from '../state/ProfileContext';
import { splitList } from '../util';
import { startRecording, stopRecording, requestMicPermission, getActiveStream } from '../lib/recorder';
import { transcribeAudio } from '../lib/openai';
import { speak, setAppVoice } from '../lib/speech';
import { watchForSilence } from '../lib/vad';
import { track } from '../lib/telemetry';

const VOICES = ['shimmer', 'nova', 'alloy', 'echo', 'fable', 'onyx'];
const SPICE_LEVELS = ['none', 'mild', 'medium', 'hot'] as const;
type SpiceLevel = typeof SPICE_LEVELS[number];
type RecState = 'idle' | 'recording' | 'working';

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
      return;
    }
    const s = getActiveStream();
    if (s) await new Promise<void>((resolve) => { watchForSilence(s, 3000, 30000, resolve); });
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
      return;
    }
    const s = getActiveStream();
    if (s) await new Promise<void>((resolve) => { watchForSilence(s, 3000, 30000, resolve); });
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

  const anyMicBusy = nameRec !== 'idle' || dislikeRec !== 'idle';

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
          aria-label="Your name. Tap mic to speak it"
          style={{ flex: 1, margin: 0 }}
        />
        <button
          onClick={speakName}
          disabled={anyMicBusy}
          aria-label={nameRec === 'recording' ? 'Listening for your name' : 'Speak your name'}
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
          {nameRec !== 'idle' ? '…' : 'Mic'}
        </button>
      </div>

      <Heading>Spice tolerance</Heading>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {SPICE_LEVELS.map((level) => {
          const active = profile.spiceTolerance === level;
          return (
            <button
              key={level}
              onClick={() => update({ spiceTolerance: level as SpiceLevel })}
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
          aria-label="Add a dislike. Tap mic to speak it"
          style={{ flex: 1, margin: 0 }}
        />
        <button
          onClick={speakDislike}
          disabled={anyMicBusy}
          aria-label={dislikeRec === 'recording' ? 'Listening for a dislike' : 'Speak a food to add to dislikes'}
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
          {dislikeRec !== 'idle' ? '…' : 'Mic'}
        </button>
      </div>

      <label
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', gap: 16 }}
      >
        <div>
          <span style={{ fontSize: 18 }}>App voice</span>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            Turn off if you use VoiceOver and the app voice talks over it.
          </p>
        </div>
        <input
          type="checkbox"
          checked={profile.appVoice !== false}
          onChange={(e) => {
            const on = e.target.checked;
            setAppVoice(on);
            update({ appVoice: on });
          }}
          aria-label="App voice. Turn off if you use VoiceOver and the app voice talks over it"
          style={{ width: 28, height: 28, flexShrink: 0 }}
        />
      </label>

      <label
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', gap: 16 }}
      >
        <div>
          <span style={{ fontSize: 18 }}>Save menu photos for analysis</span>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            When on, captured photos are uploaded so you can review them later.
          </p>
        </div>
        <input
          type="checkbox"
          checked={!!profile.imageLogging}
          onChange={(e) => update({ imageLogging: e.target.checked })}
          aria-label="Save menu photos for analysis. When on, captured photos are uploaded for later review"
          style={{ width: 28, height: 28, flexShrink: 0 }}
        />
      </label>

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

      <PrimaryButton label={saved ? 'Saved' : 'Save changes'} onClick={persist} />
      <SecondaryButton label="Back" onClick={goBack} />
      <Body style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
        Usage is recorded to improve the app.
      </Body>
      <SecondaryButton
        label="Sign out"
        tone="danger"
        hint="Clear your account and return to the login screen"
        onClick={async () => {
          track('auth', 'logout', {});
          await reset();
          navigate({ name: 'home' });
        }}
      />
    </Screen>
  );
}
