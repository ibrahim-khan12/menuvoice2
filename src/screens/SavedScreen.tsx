// Saved restaurants. Load a captured menu without re-capturing.

import { useEffect, useRef, useState } from 'react';
import { Screen, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { SavedRestaurant } from '../types';
import { loadSavedRestaurants, deleteRestaurant } from '../lib/storage';
import { speak } from '../lib/speech';
import { track } from '../lib/telemetry';

export default function SavedScreen({ navigate, goBack }: ScreenProps) {
  const [list, setList] = useState<SavedRestaurant[] | null>(null);
  const [srStatus, setSrStatus] = useState('');
  const [armedId, setArmedId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const announce = (msg: string) => { setSrStatus(msg); speak(msg); };

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

  // Two-tap delete: first tap arms with a spoken warning, second tap confirms.
  // Prevents a single mis-tap from wiping a saved menu (no undo).
  const onDelete = async (id: string, rName: string) => {
    if (armedId !== id) {
      setArmedId(id);
      announce(`Delete ${rName}? Tap Delete again to confirm.`);
      return;
    }
    setArmedId(null);
    await deleteRestaurant(id);
    track('saved', 'delete', { content: { restaurantName: rName } });
    await refresh();
    announce(`Deleted ${rName}.`);
    // Return focus to the heading so VoiceOver isn't stranded on the removed card.
    setTimeout(() => headingRef.current?.focus(), 50);
  };

  return (
    <Screen>
      <h1 className="title" ref={headingRef} tabIndex={-1}>Saved restaurants</h1>

      <p role="status" aria-live="polite" className="body" style={{ minHeight: 24, margin: 0 }}>
        {srStatus}
      </p>

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
              role="group"
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
                  label={armedId === r.id ? 'Tap to confirm' : 'Delete'}
                  hint={armedId === r.id ? `Confirm deleting ${r.name}` : `Delete ${r.name}`}
                  tone="danger"
                  onClick={() => onDelete(r.id, r.name)}
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
