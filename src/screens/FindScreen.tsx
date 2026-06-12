// Find a restaurant's menu by NAME — no URL hunting.
// The user types (or dictates with the keyboard mic) "Restaurant name, city";
// the server searches the web, reads the restaurant's site / PDF / listings,
// and returns the structured menu. If the menu isn't online, we say so plainly.

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { findMenuByName, hasApiKey } from '../lib/openai';
import { saveRestaurant } from '../lib/storage';
import { speak, stopSpeaking } from '../lib/speech';
import { track } from '../lib/telemetry';

const SEARCH_PHRASES = [
  'Still searching for their menu, hang tight.',
  'Reading their website now, almost there.',
  'Still working on it, one more moment.',
];

export default function FindScreen({ navigate, goBack }: ScreenProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const reassureRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    speak('Find a restaurant. Type the restaurant name, and the city if you know it. Then tap Find menu.');
    return () => {
      if (reassureRef.current) clearInterval(reassureRef.current);
      stopSpeaking();
    };
  }, []);

  const announce = (msg: string) => {
    setStatus(msg);
    speak(msg);
  };

  const find = async () => {
    const trimmed = query.trim();
    if (!trimmed) { announce('Please type the restaurant name first.'); return; }
    if (!hasApiKey()) {
      announce('No API key configured. Set OPENAI_API_KEY in Vercel environment variables.');
      return;
    }

    setLoading(true);
    track('find', 'search_start', { content: { query: trimmed } });
    announce(`Searching for ${trimmed} and their menu. This can take up to a minute.`);

    // Periodic reassurance — the web search is slow and silence reads as broken.
    let i = 0;
    reassureRef.current = setInterval(() => {
      speak(SEARCH_PHRASES[i % SEARCH_PHRASES.length]);
      i++;
    }, 9000);

    try {
      const { menu, restaurantName } = await findMenuByName(trimmed);
      if (reassureRef.current) clearInterval(reassureRef.current);
      const name = restaurantName?.trim() || trimmed;
      await saveRestaurant(name, menu).catch(() => {});
      navigate({ name: 'conversation', menu, restaurantName: name, source: 'url' });
    } catch (e: any) {
      if (reassureRef.current) clearInterval(reassureRef.current);
      setLoading(false);
      announce(e?.message ?? "I couldn't find that restaurant's menu online. Try adding the city to the name.");
    }
  };

  return (
    <Screen>
      <Title>Find a restaurant</Title>
      <Body>
        Type the restaurant's name — adding the city helps. I will find their menu online for
        you, whether it is on their website, a PDF, or an ordering page.
      </Body>

      <input
        className="input"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !loading) find(); }}
        placeholder="e.g. Luigi's Pizza, Springfield"
        aria-label="Restaurant name and city"
        disabled={loading}
        autoFocus
        style={{ fontSize: 18 }}
      />

      <p
        className="body"
        role="status"
        aria-live="polite"
        style={{ textAlign: 'center', minHeight: 28 }}
      >
        {status}
      </p>

      <PrimaryButton
        label={loading ? 'Searching…' : 'Find menu'}
        hint="Search the web for this restaurant's menu"
        onClick={find}
        disabled={loading || !query.trim()}
        style={{ minHeight: 80 }}
      />
      <SecondaryButton label="Cancel" onClick={goBack} disabled={loading} />
    </Screen>
  );
}
