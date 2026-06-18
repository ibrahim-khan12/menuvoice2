// Unified "Find a menu" screen — one box for ANYTHING.
//
// The user types a restaurant NAME ("Luigi's Pizza, Springfield"), pastes a
// website LINK, or a direct PDF/menu URL. We detect which it is and route to the
// right server pipeline:
//   - looks like a URL  -> parseMenuFromUrl (fetch + parse the page/PDF)
//   - otherwise (a name) -> findMenuByName (web search + read their site)
// If the menu isn't online, we say so plainly. One place to put anything.

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { findMenuByName, parseMenuFromUrl, hasApiKey } from '../lib/openai';
import { saveRestaurant } from '../lib/storage';
import { speak, stopSpeaking } from '../lib/speech';
import { track } from '../lib/telemetry';

const SEARCH_PHRASES = [
  'Still searching for their menu, hang tight.',
  'Reading their website now, almost there.',
  'Still working on it, one more moment.',
];

// A single token with a dot and a real-looking ending is a link
// (restaurant.com, site.com/menu, a .pdf). Anything with a space is a name
// ("Luigi's Pizza, Springfield"). An explicit scheme is always a link.
function looksLikeUrl(s: string): boolean {
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  if (/\s/.test(t)) return false;
  return /^[^\s]+\.[a-z]{2,}(\/|\?|$)/i.test(t);
}

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

function normalizeRestaurantQuery(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t.includes(',')) return t;
  for (const [name, abbr] of Object.entries(STATE_NAMES)) {
    const re = new RegExp(`\\s+${name}$`, 'i');
    if (re.test(t)) return t.replace(re, `, ${abbr}`);
  }
  if (/\s+[A-Za-z]{2}$/.test(t)) {
    return t.replace(/\s+([A-Za-z]{2})$/, (_, state: string) => `, ${state.toUpperCase()}`);
  }
  return t;
}

type PendingMatch = Awaited<ReturnType<typeof findMenuByName>> & { requestedName: string };

export default function FindScreen({ navigate, goBack }: ScreenProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingMatch, setPendingMatch] = useState<PendingMatch | null>(null);
  const reassureRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    speak('Find a menu. Type a restaurant name with the city, like Burger Bros, Springfield, or paste a website link. Then tap Find menu.');
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
    if (inFlightRef.current) return; // a search is already running
    const trimmed = query.trim();
    if (!trimmed) { announce('Please type a restaurant name or paste a link first.'); return; }
    setPendingMatch(null);
    if (!hasApiKey()) {
      announce('No API key configured. Set OPENAI_API_KEY in Vercel environment variables.');
      return;
    }

    const isUrl = looksLikeUrl(trimmed);

    inFlightRef.current = true;
    setLoading(true);

    try {
      if (isUrl) {
        let fullUrl = trimmed;
        if (!/^https?:\/\//i.test(fullUrl)) fullUrl = 'https://' + fullUrl;
        track('find', 'submit_url', { metadata: { url: fullUrl } });
        announce('Reading the menu from that link. This may take a moment.');
        const menu = await parseMenuFromUrl(fullUrl);
        const restaurantName = menu.restaurantName?.trim() || 'This restaurant';
        await saveRestaurant(restaurantName, menu).catch(() => {});
        navigate({ name: 'conversation', menu, restaurantName, source: 'url' });
        return;
      }

      // A restaurant name — web search can be slow, so reassure periodically.
      const normalized = normalizeRestaurantQuery(trimmed);
      track('find', 'search_start', { content: { query: normalized } });
      announce(`Searching for ${normalized} and their menu. This can take up to a minute.`);
      let i = 0;
      reassureRef.current = setInterval(() => {
        announce(SEARCH_PHRASES[i % SEARCH_PHRASES.length]);
        i++;
      }, 9000);

      const result = await findMenuByName(normalized);
      if (reassureRef.current) clearInterval(reassureRef.current);
      const name = result.restaurantName?.trim() || normalized;
      setPendingMatch({ ...result, requestedName: normalized });
      inFlightRef.current = false;
      setLoading(false);
      announce(`I found ${name}. Is this the restaurant you want?`);
    } catch (e: any) {
      if (reassureRef.current) clearInterval(reassureRef.current);
      inFlightRef.current = false;
      setLoading(false);
      const fallback = isUrl
        ? "Hey, sorry. I couldn't read the menu from that link. Try a different link, or just type the restaurant's name."
        : "I couldn't find that restaurant's menu online. Try adding the city to the name.";
      announce(e?.message ?? fallback);
    }
  };

  const confirmMatch = async () => {
    if (!pendingMatch) return;
    const name = pendingMatch.restaurantName?.trim() || pendingMatch.requestedName;
    await saveRestaurant(name, pendingMatch.menu, pendingMatch.sourceUrl).catch(() => {});
    navigate({ name: 'conversation', menu: pendingMatch.menu, restaurantName: name, source: 'find' });
  };

  const rejectMatch = () => {
    setPendingMatch(null);
    announce('Okay. Edit the restaurant name or location and search again.');
  };

  return (
    <Screen>
      <Title>Find a menu</Title>
      <Body>
        Type a restaurant name and city, or paste a website link or PDF.
        If the location is unclear, I will ask you to clarify.
      </Body>

      <input
        className="input"
        type="text"
        inputMode="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !loading) find(); }}
        placeholder="Luigi's Pizza, Springfield   or   restaurant.com/menu"
        aria-label="Restaurant name or website link"
        disabled={loading}
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

      {pendingMatch ? (
        <div className="card" role="group" aria-label="Confirm restaurant match">
          <p className="body" style={{ marginBottom: 12 }}>
            I found {pendingMatch.restaurantName?.trim() || pendingMatch.requestedName}. Is this the restaurant you want?
          </p>
          <div className="row">
            <PrimaryButton label="Yes, open this menu" onClick={confirmMatch} />
            <SecondaryButton label="No, search again" onClick={rejectMatch} />
          </div>
        </div>
      ) : null}

      <PrimaryButton
        label={loading ? 'Finding…' : 'Find menu'}
        hint="Find this restaurant's menu and read it to me"
        onClick={find}
        disabled={loading}
        style={{ minHeight: 80 }}
      />
      <SecondaryButton label="Cancel" onClick={goBack} disabled={loading} />
    </Screen>
  );
}
