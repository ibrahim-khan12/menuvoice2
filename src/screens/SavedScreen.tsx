// Saved restaurants. Load a captured menu without re-capturing.

import { useEffect, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { SavedRestaurant } from '../types';
import { loadSavedRestaurants, deleteRestaurant } from '../lib/storage';
import { speak } from '../lib/speech';
import { track } from '../lib/telemetry';

export default function SavedScreen({ navigate, goBack }: ScreenProps) {
  const [list, setList] = useState<SavedRestaurant[] | null>(null);

  const refresh = () => loadSavedRestaurants().then(setList);
  useEffect(() => { refresh(); }, []);

  // Announce the list once it loads.
  useEffect(() => {
    if (list === null) return;
    if (list.length === 0) {
      speak('No saved restaurants yet. Capture a menu and it will appear here.');
    } else {
      const names = list.map((r, i) => `${i + 1}: ${r.name}`).join('. ');
      speak(`You have ${list.length} saved restaurant${list.length === 1 ? '' : 's'}: ${names}.`);
    }
  }, [list]);

  const remove = async (id: string, rName: string) => {
    await deleteRestaurant(id);
    track('saved', 'delete', { content: { restaurantName: rName } });
    refresh();
    speak(`Deleted ${rName}.`);
  };

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
                  onClick={() => {
                    track('saved', 'open', { content: { restaurantName: r.name } });
                    navigate({ name: 'conversation', menu: r.menu, restaurantName: r.name });
                  }}
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
