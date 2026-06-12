// Find a menu from a restaurant website URL.
// User pastes (or types) the URL; the app fetches the page server-side
// (to avoid CORS), strips HTML to text, and sends it to GPT for parsing.
// Same conversation flow as after photo capture.

import { useEffect, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { parseMenuFromUrl, hasApiKey } from '../lib/openai';
import { saveRestaurant } from '../lib/storage';
import { speak } from '../lib/speech';
import { track } from '../lib/telemetry';

export default function UrlScreen({ navigate, goBack }: ScreenProps) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    speak("Menu from website. Paste the restaurant's menu URL, then tap Find menu.");
  }, []);

  const announce = (msg: string) => {
    setStatus(msg);
    speak(msg);
  };

  const find = async () => {
    const trimmed = url.trim();
    if (!trimmed) { announce('Please enter a URL first.'); return; }
    if (!hasApiKey()) {
      announce('No API key configured. Set OPENAI_API_KEY in Vercel environment variables.');
      return;
    }
    let fullUrl = trimmed;
    if (!/^https?:\/\//i.test(fullUrl)) fullUrl = 'https://' + fullUrl;

    setLoading(true);
    track('url', 'submit', { metadata: { url: fullUrl } });
    announce('Fetching the menu from that website. This may take a moment.');
    try {
      const menu = await parseMenuFromUrl(fullUrl);
      const restaurantName = menu.restaurantName?.trim() || 'This restaurant';
      await saveRestaurant(restaurantName, menu).catch(() => {});
      navigate({ name: 'conversation', menu, restaurantName, source: 'url' });
    } catch (e: any) {
      announce(e?.message ?? "Hey, sorry. I couldn't read the menu from that website. Try a different link.");
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Title>Menu from website</Title>
      <Body>
        Paste any link from the restaurant (homepage, menu page, or even a PDF menu)
        and I will read it for you. If you only know the restaurant's name, use Find a
        Restaurant on the home screen instead.
      </Body>

      <input
        className="input"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !loading) find(); }}
        placeholder="https://restaurant.com/menu"
        aria-label="Restaurant menu URL"
        disabled={loading}
        autoFocus
        style={{ fontSize: 16 }}
      />

      <p
        className="body"
        aria-live="polite"
        style={{ textAlign: 'center', minHeight: 28, color: status.startsWith('Could') || status.startsWith('I could') || status.startsWith('Please') || status.startsWith('No API') ? 'var(--danger)' : undefined }}
      >
        {status}
      </p>

      <PrimaryButton
        label={loading ? 'Reading menu…' : 'Find menu'}
        hint="Fetch and read the menu from this URL"
        onClick={find}
        disabled={loading || !url.trim()}
        style={{ minHeight: 80 }}
      />
      <SecondaryButton label="Cancel" onClick={goBack} disabled={loading} />
    </Screen>
  );
}
