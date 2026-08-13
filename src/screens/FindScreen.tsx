// Unified "Find a menu" screen — one box for ANYTHING.
//
// The user types a restaurant NAME ("Luigi's Pizza, Springfield"), pastes a
// website LINK, or a direct PDF/menu URL. We detect which it is and route to the
// right server pipeline:
//   - looks like a URL  -> parseMenuFromUrl (fetch + parse the page/PDF)
//   - otherwise (a name) -> findMenuByName (web search + read their site)
//
// While searching, we explain each real stage of what Meet My Menu AI is doing (no
// fake percentages), let the user ask "What are you doing?" to repeat the
// current step, and offer a clear Cancel. When a name resolves we CONFIRM the
// branch and source with the user (official vs third-party, location-specific or
// generic) before opening it. On failure we say specifically what went wrong and
// offer practical next actions.
//
// This screen never speaks — every stage lands in the role="status" live
// region so VoiceOver announces it. App TTS is reserved for Conversation Mode.

import { useEffect, useRef, useState } from 'react';
import { Screen, Title, Body, PrimaryButton, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';
import { findMenuByName, parseMenuFromUrl, hasApiKey } from '../lib/openai';
import { friendlyError, SERVICE_UNAVAILABLE_MSG } from '../lib/errors';
import { saveRestaurant } from '../lib/storage';
import { track } from '../lib/telemetry';
import { MenuProvenance } from '../types';

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

/** The location half of a normalized "Name, City ST" query, for the status copy. */
function locationPart(normalized: string): string {
  const idx = normalized.indexOf(',');
  return idx >= 0 ? normalized.slice(idx + 1).trim() : '';
}

// Honest, ordered descriptions of what the server pipeline is actually doing.
// These advance on a timer and STOP at the last step until the response lands;
// they describe what Meet My Menu AI is attempting, never claim a step succeeded, and
// never show fake progress percentages. The final result corrects the story.
function nameStages(location: string): string[] {
  return [
    'Starting the search.',
    location ? `Looking for the restaurant near ${location}.` : 'Looking for the restaurant.',
    'Checking their official website for the menu.',
    'Reading and organizing the menu items.',
  ];
}
const URL_STAGES = [
  'Opening that link.',
  'Looking for the menu on that page.',
  'Reading and organizing the menu items.',
];

type PendingMatch = Awaited<ReturnType<typeof findMenuByName>> & { requestedName: string };

// One-line source evidence for the confirm card, e.g.
// "Source: their website. This looks specific to this location."
function evidenceLine(p: MenuProvenance | undefined): string {
  if (!p) return '';
  const src =
    p.sourceType === 'third_party'
      ? `Source: ${p.sourceLabel ?? 'a third-party listing'} (not the restaurant directly).`
      : `Source: ${p.sourceLabel ?? 'an online source'}.`;
  const scope =
    p.locationScope === 'location_specific'
      ? ' This looks specific to this location.'
      : p.locationScope === 'generic'
        ? ' This looks like the general chain menu, which may differ at this branch.'
        : ' I could not confirm it is specific to this branch.';
  const complete = p.completeness === 'partial' ? ' It may be incomplete.' : '';
  return src + scope + complete;
}

export default function FindScreen({ navigate, goBack }: ScreenProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingMatch, setPendingMatch] = useState<PendingMatch | null>(null);
  const [failure, setFailure] = useState<{ message: string; wasUrl: boolean } | null>(null);
  const stageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentStatusRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const failureHeadingRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    return () => {
      if (stageTimerRef.current) clearInterval(stageTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const announce = (msg: string) => {
    currentStatusRef.current = msg;
    setStatus(msg);
  };

  // Walk the honest stage list on a timer. Surfaces each new stage once in the
  // live region, spaced out so it informs without flooding the screen reader.
  // Holds on the final stage.
  const startStageNarration = (stages: string[]) => {
    if (stageTimerRef.current) clearInterval(stageTimerRef.current);
    let i = 0;
    announce(stages[0]);
    stageTimerRef.current = setInterval(() => {
      i += 1;
      if (i >= stages.length) {
        if (stageTimerRef.current) clearInterval(stageTimerRef.current);
        return;
      }
      announce(stages[i]);
    }, 7000);
  };

  const stopStageNarration = () => {
    if (stageTimerRef.current) clearInterval(stageTimerRef.current);
    stageTimerRef.current = null;
  };

  const find = async () => {
    if (inFlightRef.current) return; // a search is already running
    const trimmed = query.trim();
    if (!trimmed) { announce('Please type a restaurant name or paste a link first.'); return; }
    setPendingMatch(null);
    setFailure(null);
    if (!hasApiKey()) {
      announce(SERVICE_UNAVAILABLE_MSG);
      return;
    }

    const isUrl = looksLikeUrl(trimmed);
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    setLoading(true);

    try {
      if (isUrl) {
        let fullUrl = trimmed;
        if (!/^https?:\/\//i.test(fullUrl)) fullUrl = 'https://' + fullUrl;
        track('find', 'submit_url', { metadata: { url: fullUrl } });
        announce('Reading the menu from that link.');
        startStageNarration(URL_STAGES);
        const { menu, provenance, sourceUrl } = await parseMenuFromUrl(fullUrl, controller.signal);
        stopStageNarration();
        const restaurantName = menu.restaurantName?.trim() || 'This restaurant';
        await saveRestaurant(restaurantName, menu, {
          sourceUrl: sourceUrl ?? fullUrl,
          location: provenance?.confirmedLocation,
          provenance,
        }).catch(() => {});
        navigate({ name: 'conversation', menu, restaurantName, source: 'url', provenance });
        return;
      }

      // A restaurant name — web search can be slow, so narrate the real stages.
      const normalized = normalizeRestaurantQuery(trimmed);
      const where = locationPart(normalized);
      track('find', 'search_start', { content: { query: normalized } });
      announce(`Searching for ${normalized} and their menu. This can take up to a minute.`);
      startStageNarration(nameStages(where));

      const result = await findMenuByName(normalized, controller.signal);
      stopStageNarration();
      const name = result.restaurantName?.trim() || normalized;
      const place = result.provenance?.confirmedLocation?.trim() || result.address?.trim();
      setPendingMatch({ ...result, requestedName: normalized });
      inFlightRef.current = false;
      setLoading(false);
      const evidence = evidenceLine(result.provenance);
      announce(
        `I found ${name}${place ? ` in ${place}` : ''}. ${evidence} Is this the right place? ` +
          'Tap Open this menu to continue, or Not this one to search again.',
      );
      // Move focus to the confirm action (a meaningful next step the user can take).
      setTimeout(() => confirmBtnRef.current?.focus(), 60);
    } catch (e: any) {
      stopStageNarration();
      inFlightRef.current = false;
      setLoading(false);
      if (e?.name === 'AbortError') {
        announce('Search canceled. Edit the name or link and try again when you are ready.');
        return;
      }
      const fallback = isUrl
        ? "I couldn't read that link. Try another link, or type the restaurant name and city."
        : "I couldn't find that restaurant's menu online. Try adding the city and state to the name.";
      const message = friendlyError(e, fallback);
      setFailure({ message, wasUrl: isUrl });
      announce(message);
      // Land focus on the failure explanation so the next actions are reachable.
      setTimeout(() => failureHeadingRef.current?.focus(), 60);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    stopStageNarration();
    inFlightRef.current = false;
    setLoading(false);
  };

  const confirmMatch = async () => {
    if (!pendingMatch) return;
    const name = pendingMatch.restaurantName?.trim() || pendingMatch.requestedName;
    const provenance = pendingMatch.provenance;
    await saveRestaurant(name, pendingMatch.menu, {
      sourceUrl: pendingMatch.sourceUrl,
      location: provenance?.confirmedLocation ?? pendingMatch.address ?? undefined,
      provenance,
    }).catch(() => {});
    navigate({ name: 'conversation', menu: pendingMatch.menu, restaurantName: name, source: 'find', provenance });
  };

  const rejectMatch = () => {
    setPendingMatch(null);
    announce('Okay. Edit the restaurant name or location and search again.');
  };

  return (
    <Screen>
      <Title>Find a menu</Title>
      <Body>Enter a restaurant name and city, or paste a menu link or PDF.</Body>

      <input
        className="input"
        type="text"
        inputMode="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !loading) find(); }}
        placeholder="Luigi's Pizza, Springfield or restaurant.com/menu"
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

      {/* While searching: let the user repeat the current step or cancel. */}
      {loading && (
        <div className="row" role="group" aria-label="Search controls">
          <SecondaryButton
            label="What are you doing?"
            hint="Repeat the current step"
            onClick={() => {
              // Clear then re-set the live region: aria-live only fires on a
              // CHANGE, so re-setting identical text would stay silent.
              const msg = currentStatusRef.current || 'Still working on it.';
              setStatus('');
              setTimeout(() => setStatus(msg), 60);
            }}
          />
          <SecondaryButton
            label="Cancel search"
            hint="Stop searching"
            tone="danger"
            onClick={cancel}
          />
        </div>
      )}

      {pendingMatch ? (
        <div className="card" role="group" aria-label="Confirm restaurant match">
          <p className="body" style={{ marginBottom: 6, fontWeight: 600 }}>
            {pendingMatch.restaurantName?.trim() || pendingMatch.requestedName}
            {(pendingMatch.provenance?.confirmedLocation?.trim() || pendingMatch.address?.trim())
              ? ` — ${pendingMatch.provenance?.confirmedLocation?.trim() || pendingMatch.address?.trim()}`
              : ''}
          </p>
          {evidenceLine(pendingMatch.provenance) && (
            <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
              {evidenceLine(pendingMatch.provenance)}
            </p>
          )}
          <p className="body" style={{ marginBottom: 12 }}>Is this the restaurant you want?</p>
          <div className="row">
            <button
              ref={confirmBtnRef}
              className="btn btn-primary"
              onClick={confirmMatch}
              aria-label="Open this menu. Use this restaurant"
              style={{ flex: 1 }}
            >
              Open this menu
            </button>
            <SecondaryButton label="Not this one" hint="Search again" onClick={rejectMatch} style={{ flex: 1 }} />
          </div>
        </div>
      ) : null}

      {/* Specific failure + practical next actions. */}
      {failure ? (
        <div className="card" role="group" aria-label="Search did not work">
          <p
            className="body"
            ref={failureHeadingRef}
            tabIndex={-1}
            style={{ marginBottom: 12, fontWeight: 600 }}
          >
            {failure.message}
          </p>
          <div className="col">
            <SecondaryButton label="Try again" hint="Search the same thing again" onClick={() => { setFailure(null); find(); }} />
            <SecondaryButton
              label="Scan the physical menu"
              hint="Use the camera to read the printed menu"
              onClick={() => navigate({ name: 'capture' })}
            />
          </div>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            You can also paste a direct link to their menu page in the box above.
          </p>
        </div>
      ) : null}

      <PrimaryButton
        label={loading ? 'Finding...' : 'Find menu'}
        hint="Search for this menu"
        onClick={find}
        disabled={loading}
        style={{ minHeight: 80 }}
      />
      <SecondaryButton label="Cancel" onClick={goBack} disabled={loading} />
    </Screen>
  );
}
