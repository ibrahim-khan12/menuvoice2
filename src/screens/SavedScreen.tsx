// Saved restaurants. Load a captured menu without re-capturing.
// Voice: on load, the app reads the list aloud. Say a restaurant name (or its
// number) to open it, or "delete [name]" to remove it, or "back" to go home.

import { useEffect, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { SavedRestaurant } from '../types';
import { loadSavedRestaurants, deleteRestaurant } from '../lib/storage';
import { useProfile } from '../state/ProfileContext';
import { useVoiceNav, fuzzyPickName } from '../hooks/useVoiceNav';

export default function SavedScreen({ navigate, goBack }: ScreenProps) {
  const { profile } = useProfile();
  const [list, setList] = useState<SavedRestaurant[] | null>(null);

  const refresh = () => loadSavedRestaurants().then(setList);
  useEffect(() => { refresh(); }, []);

  const { phase, announce, listen, finish } = useVoiceNav({
    voice: profile.ttsVoice,
    commands: [
      { id: 'back',   keywords: ['back', 'go back', 'home', 'cancel', 'exit'] },
      { id: 'pick',   keywords: [] }, // handled in onNoMatch via fuzzy name match
      { id: 'delete', keywords: ['delete', 'remove', 'erase'] },
    ],
    onCommand: async (id, transcript) => {
      if (id === 'back') {
        goBack();
        return;
      }
      if (id === 'delete' && list) {
        const names = list.map((r) => r.name);
        const match = fuzzyPickName(transcript, names);
        if (match) {
          const r = list.find((x) => x.name === match)!;
          await deleteRestaurant(r.id);
          await refresh();
          await announce(`Deleted ${match}.`);
        } else {
          await announce("I couldn't find that restaurant. Say 'delete' followed by the name.");
        }
        return;
      }
    },
    onNoMatch: async (transcript) => {
      if (!list || list.length === 0) return 'No saved restaurants yet.';
      const names = list.map((r) => r.name);
      // Numeric pick: "first", "second", "one", "two", etc.
      const numMatch = parseOrdinal(transcript);
      if (numMatch !== null && numMatch < list.length) {
        navigate({ name: 'conversation', menu: list[numMatch].menu, restaurantName: list[numMatch].name });
        return '';
      }
      const match = fuzzyPickName(transcript, names);
      if (match) {
        const r = list.find((x) => x.name === match)!;
        navigate({ name: 'conversation', menu: r.menu, restaurantName: r.name });
        return '';
      }
      return `I didn't find that. Say a restaurant name — ${names.slice(0, 3).join(', ')} — or "back".`;
    },
  });

  // Announce the list once it loads.
  useEffect(() => {
    if (list === null) return;
    if (list.length === 0) {
      announce('No saved restaurants yet. Capture a menu and it will appear here. Say "back" or tap Back.');
    } else {
      const names = list.map((r, i) => `${i + 1}: ${r.name}`).join('. ');
      announce(
        `You have ${list.length} saved restaurant${list.length === 1 ? '' : 's'}: ${names}. ` +
          `Say a name or its number to open it, "delete" followed by a name to remove it, or "back".`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const remove = async (id: string, rName: string) => {
    await deleteRestaurant(id);
    refresh();
    announce(`Deleted ${rName}.`);
  };

  const busy = phase === 'announcing' || phase === 'transcribing';
  const micLabel =
    phase === 'recording'    ? 'Done speaking' :
    phase === 'transcribing' ? 'Hearing you…'  :
    phase === 'announcing'   ? 'Please wait…'  :
                               'Tap to speak';

  return (
    <Screen>
      <Title>Saved restaurants</Title>

      {list === null ? (
        <Body>Loading…</Body>
      ) : list.length === 0 ? (
        <Body>No saved restaurants yet. Capture a menu and it will appear here.</Body>
      ) : (
        <div className="col">
          {list.map((r, i) => (
            <div
              key={r.id}
              className="card"
              aria-label={`${i + 1}: ${r.name}, captured ${formatDate(r.capturedAt)}`}
            >
              <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 700 }}>#{i + 1}</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{r.name}</div>
              <div className="muted" style={{ marginTop: 4 }}>
                Last visit: {formatDate(r.capturedAt)}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <PrimaryButton
                  label="Open"
                  hint={`Talk to MenuVoice about the menu for ${r.name}`}
                  onClick={() => navigate({ name: 'conversation', menu: r.menu, restaurantName: r.name })}
                  style={{ flex: 1 }}
                />
                <SecondaryButton
                  label="Browse"
                  hint={`Browse the menu for ${r.name} silently`}
                  onClick={() => navigate({ name: 'browse', menu: r.menu, restaurantName: r.name })}
                  style={{ flex: 1 }}
                />
                <SecondaryButton
                  label="Delete"
                  tone="danger"
                  onClick={() => remove(r.id, r.name)}
                  style={{ flex: 1 }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="spacer" />

      <PrimaryButton
        label={micLabel}
        hint="Speak a command — say a restaurant name, a number, or 'back'"
        onClick={phase === 'recording' ? finish : listen}
        disabled={busy || list === null}
        style={{
          minHeight: 80,
          background: phase === 'recording' ? 'var(--success)' : undefined,
        }}
      />

      <SecondaryButton label="Back" onClick={goBack} />
    </Screen>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function parseOrdinal(t: string): number | null {
  const s = t.toLowerCase();
  const words: Record<string, number> = {
    first: 0, one: 0, '1st': 0, '1': 0,
    second: 1, two: 1, '2nd': 1, '2': 1,
    third: 2, three: 2, '3rd': 2, '3': 2,
    fourth: 3, four: 3, '4th': 3, '4': 3,
    fifth: 4, five: 4, '5th': 4, '5': 4,
  };
  for (const [word, idx] of Object.entries(words)) {
    if (s.includes(word)) return idx;
  }
  return null;
}
