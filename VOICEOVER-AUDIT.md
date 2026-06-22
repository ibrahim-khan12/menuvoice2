# MenuVoice — iOS VoiceOver + Safari Audit
Date: 2026-06-12. Scope: all screens in `src/screens/`, `src/components.tsx`, `src/App.tsx`, `src/index.css`, `index.html`.
Priorities: **P0** blocks blind users · **P1** friction · **P2** polish.

What's already good: skip link, `lang="en"`, no zoom lock, 64px+ touch targets everywhere, `:focus-visible` ring, `prefers-reduced-motion`, real `<button>` elements throughout, `aria-pressed` toggles, `role="alert"` for errors, `aria-hidden` video/overlays, MenuDocument heading-rotor design, Screen focus-on-mount.

---

## P0 — Blocks blind users

### P0-1. App TTS talks over VoiceOver on screen entry — no global way to silence the app voice
**Files:** `src/screens/LoginScreen.tsx:32-46`, `src/screens/FindScreen.tsx:27`, `src/screens/UrlScreen.tsx:20`, `src/screens/SavedScreen.tsx:18-26`, `src/screens/ConversationScreen.tsx:139-154`
**Problem:** Each of these screens calls `speak(...)` on mount at the same moment `Screen` (`src/components.tsx:10`) moves focus to `<main>`, which makes VoiceOver start reading the same content. A VoiceOver user gets two voices simultaneously, every screen change. The only voice on/off switch is `speakMode`, which exists solely inside ConversationScreen. SavedScreen is the worst case: it speaks the entire numbered list while VoiceOver reads the identical cards.
**Fix:** Add a persistent profile setting (e.g. `profile.appVoice: boolean`, toggle in Settings, announced on first launch: "If you use VoiceOver, you can turn off my voice in Settings") and gate every mount-time `speak()` behind it. Centralize in `src/lib/speech.ts`:
```ts
// speech.ts
let appVoiceEnabled = true;
export function setAppVoice(on: boolean) { appVoiceEnabled = on; stopSpeaking(); }
export async function speak(text: string, voice?: string): Promise<void> {
  if (!appVoiceEnabled) return;        // VoiceOver users: DOM/live regions carry the info
  ...
}
```
Then ensure every spoken message also exists in the DOM (see P0-3, P1-4, P1-6) so nothing is lost when the app voice is off.

### P0-2. ConversationScreen: aria-live phase changes are spoken by VoiceOver straight into the auto-opened mic
**File:** `src/screens/ConversationScreen.tsx:405-413` (phase indicator) + `:193-197` (mic opens 150 ms after earcon)
**Problem:** In voice mode the mic auto-opens after each reply. At that instant `phase` flips to `recording`, the `aria-live="polite"` indicator updates to "Listening — tap when you're done", and VoiceOver speaks it out loud — directly into the now-open Web Speech recognizer. The app then transcribes VoiceOver's own voice as the user's utterance and replies to it. The conversation loop breaks for every VoiceOver user.
**Fix:** Don't let the recording-phase transition hit the live region. Make the indicator live only when not recording, and convey "listening" via the earcon + vibration (already present) plus the button label (focusable, readable on demand):
```tsx
<div
  role="status"
  aria-live={phase === 'recording' ? 'off' : 'polite'}
  className={`phase-indicator phase-${phaseClass(phase)}`}
>
```
Also delay `speechManagerRef.current.start()` until ~1s after the live-region update would have been spoken, or call `setPhase('recording')` *before* `earconStart()` so any announcement finishes before the recognizer starts.

### P0-3. FindScreen: up to 60 s of "still searching" reassurance is TTS-only — silent screen for VoiceOver users
**File:** `src/screens/FindScreen.tsx:52-56`
**Problem:** The 9-second reassurance interval calls `speak(...)` but never `setStatus(...)`. With app TTS muted/over-talked (see P0-1), the `role="status"` region never changes after the initial message; a VoiceOver user waits a minute on a seemingly dead screen.
**Fix:**
```ts
reassureRef.current = setInterval(() => {
  const msg = SEARCH_PHRASES[i % SEARCH_PHRASES.length];
  setStatus(msg);   // live region picks it up for VoiceOver
  speak(msg);
  i++;
}, 9000);
```
(CaptureScreen's analysis reassurance has the same gap: `src/screens/CaptureScreen.tsx:85-89` speaks `ANALYSIS_PHRASES` without `setStatus` — apply the same fix.)

---

## P1 — Friction

### P1-1. ConversationScreen heading order broken: h2 before h1, duplicate restaurant heading
**File:** `src/screens/ConversationScreen.tsx:403` (top `<h2>{restaurantName}</h2>`) and `:62-68` (MenuDocument `<h1>{restaurantName}</h1>` mid-page)
**Problem:** The page begins with an h2, then an h1 appears mid-document inside MenuDocument; the rotor shows h2 → h1 → h2 → h3 → h4 with the restaurant name twice. Confusing heading navigation in the screen blind users live on.
**Fix:** Make the top heading the single h1 (and the browse-mode focus target); demote MenuDocument's inner h1 to a section focus anchor:
```tsx
// top of return:
<h1 ref={menuHeadingRef} tabIndex={-1} className="heading" style={{ marginTop: 4 }}>{restaurantName}</h1>
// MenuDocument: drop the inner <h1>; keep hierarchy h2 category → h3 item → h4 sub:
<section aria-label={`Full menu for ${restaurantName}`} tabIndex={-1} ref={sectionRef} style={{ marginTop: 24 }}>
```
Point the browse-mode focus (`:349`) at the section (or first `h2`) instead of the removed h1.

### P1-2. HomeScreen has no heading at all
**File:** `src/screens/HomeScreen.tsx:10`
**Problem:** No h1 anywhere — rotor heading navigation finds nothing, and focus lands on an unnamed `<main>`. Every other screen has a Title.
**Fix:**
```tsx
<Screen>
  <Title>MenuVoice</Title>
  <div className="col" style={{ marginTop: 32 }}>
```

### P1-3. OnboardingScreen: focus is lost when steps change
**File:** `src/screens/OnboardingScreen.tsx:45-52` (step effect), `:74` ("Let's begin" unmounts itself)
**Problem:** Tapping "Let's begin" (or Next) removes the focused button; focus falls back to `<body>` and VoiceOver is stranded on a dead node. The app voice covers it today, but with P0-1's quiet mode it becomes a dead end.
**Fix:** Focus the new step's heading:
```tsx
const stepHeadingRef = useRef<HTMLHeadingElement>(null);
useEffect(() => {
  if (step !== 'intro') stepHeadingRef.current?.focus();
  ...
}, [step]);
// in VoiceStep: <Heading> → <h2 className="heading" tabIndex={-1} ref={headingRef}>{question}</h2>
```

### P1-4. Mic transcription feedback ("I heard: …") is TTS-only on Login, Onboarding, Settings
**Files:** `src/screens/LoginScreen.tsx:117`, `src/screens/OnboardingScreen.tsx:163`, `src/screens/SettingsScreen.tsx:70,104`
**Problem:** After speaking into the field mic, confirmation ("I heard: name@x.com", "Name updated to X", "Added X to your dislikes") goes only through `speak()`. No `role="status"` region — VoiceOver users get silence and must hunt for the input to verify.
**Fix:** Add one status line per screen and route all spoken feedback through it:
```tsx
const [srStatus, setSrStatus] = useState('');
const announce = (msg: string) => { setSrStatus(msg); speak(msg); };
...
<p role="status" aria-live="polite" className="body" style={{ minHeight: 28 }}>{srStatus}</p>
```
Use `announce()` everywhere these screens currently call bare `speak()` for state changes (mic errors too: LoginScreen.tsx:86,94,119; OnboardingScreen.tsx:141,149,165).

### P1-5. SavedScreen: delete gives no DOM feedback and orphans focus
**File:** `src/screens/SavedScreen.tsx:28-33` and `:66-71`
**Problem:** "Deleted X" is `speak()`-only; the card (with the focused Delete button) unmounts, so VoiceOver focus is lost and nothing announces what happened. Also destructive with no confirm.
**Fix:**
```tsx
const [srStatus, setSrStatus] = useState('');
const remove = async (id: string, rName: string) => {
  await deleteRestaurant(id);
  refresh();
  setSrStatus(`Deleted ${rName}.`);   // render in a role="status" <p>
  speak(`Deleted ${rName}.`);
  headingRef.current?.focus();        // return focus to the "Saved restaurants" h1 (add tabIndex={-1})
};
```
P2 add-on: first tap arms ("Tap Delete again to confirm"), second tap deletes.

### P1-6. Settings "Save changes → Saved" is never announced
**File:** `src/screens/SettingsScreen.tsx:32-36`, button at `:322`
**Problem:** `persist()` flips the button label to "Saved" for 2 s — purely visual. No `speak()`, no live region. A VoiceOver user doesn't know allergies (a safety feature) were saved.
**Fix:** In `persist()`: `announce('Saved. I will warn you about ' + (splitList(allergies).join(', ') || 'nothing') + '.')` using the P1-4 pattern, and add the `role="status"` line near the button.

### P1-7. Disabled submit buttons with no explanation (Find / Url)
**Files:** `src/screens/FindScreen.tsx:105`, `src/screens/UrlScreen.tsx:86`
**Problem:** `disabled={loading || !query.trim()}` means VoiceOver reads "Find menu, dimmed" with no way to learn why; the helpful `announce('Please type the restaurant name first.')` branch (`FindScreen.tsx:41`) is unreachable. iOS VoiceOver also skips dimmed buttons in some navigation modes.
**Fix:** Keep the button enabled when the field is empty so the announce path runs; only disable during `loading` — or use `aria-disabled`:
```tsx
disabled={loading}   // empty input → find() announces "Please type the restaurant name first."
```

### P1-8. CaptureScreen: coach() + aria-live status double-speak during scanning
**File:** `src/screens/CaptureScreen.tsx:115-118` (`onCoach: (msg) => { setStatus(msg); coach(msg); }`) with live region at `:352-354`
**Problem:** Every scanner coaching message is simultaneously spoken by browser speechSynthesis *and* announced by VoiceOver via the `role="status"` region — two voices saying the same sentence, several times per scan.
**Fix:** Gate `coach()` behind the P0-1 app-voice setting (VoiceOver users get the live region only). If app voice is on, suppress the live region instead:
```tsx
<p role="status" aria-live={appVoice ? 'off' : 'polite'} className="body" ...>{status}</p>
```

### P1-9. UrlScreen status region lacks role="status"
**File:** `src/screens/UrlScreen.tsx:74-80`
**Problem:** Only `aria-live="polite"` on a `<p>`; iOS Safari/VoiceOver is more reliable when the element also has `role="status"` and exists with stable identity (it does). FindScreen and CaptureScreen already do this correctly.
**Fix:** `<p className="body" role="status" aria-live="polite" ...>` — match FindScreen.tsx:92-99.

---

## P2 — Polish

### P2-1. Unused global live region
**File:** `src/App.tsx:82-88`
`#sr-announce` is rendered but nothing ever writes to it. Either delete it, or (better) use it as the shared `announce()` target for P1-4/5/6 via a tiny helper: `export function srAnnounce(msg: string) { const el = document.getElementById('sr-announce'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 50); } }`

### P2-2. aria-label on non-interactive divs is unreliable on iOS
**Files:** `src/screens/CaptureScreen.tsx:287-293` (photo-count card), `src/screens/SavedScreen.tsx:46-50` (restaurant card)
VoiceOver often ignores `aria-label` on a plain `<div>` with no role; the visible text already reads fine. Remove the labels, or give the SavedScreen card `role="group"` so the label is honored: `<div role="group" aria-label={...}>`.

### P2-3. Phase indicator aria-label duplicates its text
**File:** `src/screens/ConversationScreen.tsx:409`
`aria-label={indicator.label}` on a live region whose text content is the same string can cause double announcement on some VoiceOver versions. Drop the `aria-label`; the text change drives the announcement.

### P2-4. Buttons that disable mid-interaction drop VoiceOver focus
**Files:** `src/screens/ConversationScreen.tsx:384-390,461` ("One moment…" disabled), `:489-493` ("Saving preferences…"), `src/screens/LoginScreen.tsx:173`, `src/screens/OnboardingScreen.tsx:181`
When the focused button becomes `disabled`, iOS VoiceOver loses its position. Prefer `aria-disabled` with a no-op guard:
```tsx
<button aria-disabled={actionConfig.disabled}
        onClick={() => { if (!actionConfig.disabled) actionConfig.onClick(); }} ...>
```

### P2-5. Spice level and Voice pickers should be radio groups
**File:** `src/screens/SettingsScreen.tsx:150-177` (spice), `:294-320` (voice)
Mutually-exclusive choices exposed as independent `aria-pressed` toggles; "selected" is also baked into the label (redundant with the state). Use radio semantics so VoiceOver reports "2 of 4":
```tsx
<div role="radiogroup" aria-label="Spice tolerance" className="row">
  <button role="radio" aria-checked={active} aria-label={`Spice ${level}`} ...>
```
Same for voices, and consider speaking a one-word preview in the chosen voice on tap.

### P2-6. Settings mic buttons say "Speak your name" while transcribing
**File:** `src/screens/SettingsScreen.tsx:133,223`
The `working` state shows "…" but the aria-label only distinguishes recording vs idle. Add a third label: `nameRec === 'working' ? 'Transcribing, one moment' : ...`.

### P2-7. Double autofocus race on Find/Url screens
**Files:** `src/screens/FindScreen.tsx:88`, `src/screens/UrlScreen.tsx:70` vs `src/components.tsx:10`
`Screen` focuses `<main>` on mount and the input has `autoFocus`; on iOS the keyboard pops while VoiceOver is mid-announcement of the screen. Remove `autoFocus` and let users reach the input one swipe after the heading.

### P2-8. Sign out has no confirmation
**File:** `src/screens/SettingsScreen.tsx:327-336`
One tap wipes the profile and returns to login. Use the two-tap arm pattern from P1-5.

### P2-9. Google Sign-In iframe is third-party
**File:** `src/screens/LoginScreen.tsx:136-144`
The GIS button renders inside an iframe; label/contrast are out of your control. The "Use email instead" escape hatch (good) should always be reachable — it already is when `!showEmail`. Just verify VoiceOver can reach the iframe button in testing; if flaky, prefer a custom button with `useGoogleLogin()` flow.

### P2-10. Root loading state isn't announced
**File:** `src/App.tsx:46-52`
"Loading MenuVoice…" is plain text with no focus or live region; usually too brief to matter, but add `role="status"` to the `<p>` for slow loads.
