# IDEAS — prioritized backlog (2026-06-12)

Grounded in the current code. Each idea cites the files it builds on. Effort:
S = under a day, M = 1–3 days, L = a week+.

---

## Tier 1 — highest impact at the table

### 1. Allergen flags in the browsable menu (not just in chat)
Profile allergies already exist (`src/types.ts` UserProfile.allergies, collected in
`src/screens/OnboardingScreen.tsx`) and the chat system prompt flags allergens
(`buildSystemPrompt` in `src/lib/openai.ts`), but the VoiceOver-browsable
`MenuDocument` in `src/screens/ConversationScreen.tsx` renders every item with no
warning. Add a per-item "May contain: peanuts — your allergy" line (an h4, matching
the existing Description/Ingredients pattern) plus an optional "hide items with my
allergens" toggle, matched against `item.ingredients`.
- **Why:** voice-mode users get warned; browse-mode (VoiceOver rotor) users currently
  don't. Allergies are the one safety-critical feature, and browse mode is the default
  when speakMode is off.
- **Effort:** S–M (matching is client-side string work; no API changes).
- **Risk:** `ingredients` is LLM-inferred ("best-effort" per the prompt in
  `parseMenuFromImages`), so wording must be "may contain", never "safe". Misses are
  possible — keep the existing chat-level hard rule as the backstop.

### 2. Speak the restaurant name instead of typing it (FindScreen voice input)
`src/screens/FindScreen.tsx` is a text `<input>` with autoFocus — the only typed-entry
path in an otherwise voice-first app. The mic→Whisper pipeline already exists and is
used in onboarding (`src/lib/recorder.ts`, `src/lib/vad.ts`, `transcribeAudio` in
`src/lib/openai.ts`); wire the same tap-and-speak button into FindScreen.
- **Why:** typing a restaurant name on a phone keyboard with VoiceOver is slow and
  error-prone; this is the entry point to the app's biggest feature (find-by-name).
- **Effort:** S (reuse the OnboardingScreen mic pattern).
- **Risk:** Whisper mishears proper nouns; read back the transcription and confirm
  before firing the 15–45s search.

### 3. Incomplete-menu honesty + "add more photos" supplement flow
`parseMenuFromImages` (`src/lib/openai.ts`) already accepts multiple photos of the same
menu and `CaptureScreen.tsx` already collects a `photos[]` array — but once you're on
ConversationScreen there is no way back to add the page you missed. Detect a likely
partial menu (e.g. single category, items with no prices, or model `notes` mentioning
unreadable photos), open with exactly "This wasn't a complete menu." (one sentence),
and add an "Add more photos" button that returns to CaptureScreen carrying the existing
photos, then re-parses old + new together.
- **Why:** a blind user can't tell the photo cut off the dinner section; today the app
  silently presents half a menu as the whole menu, which breaks trust in every answer.
- **Effort:** M (route param to carry photos through `src/nav.ts`; re-parse is free).
- **Risk:** partial-menu detection is heuristic; keep the announcement to one sentence
  and never block the conversation on it.

### 4. "Tell the waiter" card
After the user decides (already extracted by `extractSessionLearnings` →
`SessionLearnings.orders` in `src/lib/openai.ts`), offer a screen showing the order
plus allergies in very large high-contrast text, with a button to play it through TTS
at the table.
- **Why:** the hardest unsolved moment is the handoff to a sighted waiter — the user
  knows what they want but relaying dish names and allergy constraints verbally is
  where mistakes happen. The phone can do it: "I'll have the salmon piccata. Please
  note a shellfish allergy."
- **Effort:** M (new screen + route; data already exists in profile + learnings).
- **Risk:** must be dead-simple to reach mid-conversation — a voice command
  ("show my order") plus a button, or it won't be used under social pressure.

## Tier 2 — speed and resilience

### 5. GPS-assisted find: auto-append city / "restaurants near me"
`FindScreen` tells the user "adding the city helps" — but the phone knows the city.
Use `navigator.geolocation` and pass lat/lng (or a reverse-geocoded city) into the
`buildPrompt` query in `api/find-menu.ts`, which already uses `web_search` and can
disambiguate locations.
- **Why:** a blind user may not know or remember the city/suburb spelling; ambiguous
  chains ("Luigi's Pizza") currently fail or return the wrong location's menu.
- **Effort:** M (geolocation permission UX + prompt change; "near me" suggestions list
  is an extra M on top).
- **Risk:** permission prompt must be spoken/explained; web_search with raw
  coordinates is untested — verify with `scripts/test-find-menu.mjs` first.

### 6. Quick-resume: "Last restaurant" on Home
`src/lib/storage.ts` already unshifts the newest save to the front of the saved list.
Add one Home button (`src/screens/HomeScreen.tsx`): "Continue with {name}" that jumps
straight to ConversationScreen with the most recent `SavedRestaurant`.
- **Why:** re-opening yesterday's restaurant currently takes Home → Saved → listen to
  the full spoken list (`SavedScreen.tsx` reads every name) → Open. At a table you
  want one tap.
- **Effort:** S.
- **Risk:** none meaningful; saved menus go stale — say the captured date (already
  stored as `capturedAt`).

### 7. Offline / dead-zone mode
Saved menus live in localStorage (`src/lib/storage.ts`) so browsing works offline in
principle, but every voice turn needs `/api/chat`, OpenAI TTS (`/api/tts`), and there
is no offline detection anywhere. Detect `navigator.onLine`/fetch failure, announce
"You're offline — I can still read your saved menus with VoiceOver", force browse mode
in ConversationScreen, and use the browser `speechSynthesis` fallback that already
exists in `src/lib/speech.ts` (tracked as `tts_fallback` per ANALYTICS.md). A service
worker for the app shell makes the SPA itself load offline.
- **Why:** restaurants are classic dead zones (basements, thick walls). Today the app
  just hangs or errors mid-meal.
- **Effort:** M (detection + graceful degradation) to L (full PWA service worker).
- **Risk:** iOS Safari service-worker quirks; ship detection + messaging first, PWA
  caching second.

### 8. Deterministic voice shortcuts in conversation
`ConversationScreen.tsx` already pattern-matches EXIT_PHRASES and REPEAT_PHRASES
locally before hitting the LLM. Extend the same list: "read the whole menu",
"read the {category}", "skip", "slower/faster" — answered instantly from the
`ParsedMenu` in memory with zero LLM round-trip.
- **Why:** ANALYTICS.md tracks `llm_first_token` latency for a reason — every LLM
  round-trip is seconds of silence at the table. Reading a category is a lookup, not
  a question.
- **Effort:** M (phrase matching is easy; speech-rate control touches
  `src/lib/speech.ts`).
- **Risk:** phrase lists grow brittle; keep the LLM as fallthrough (it already is).

## Tier 3 — sharing, polish, hygiene

### 9. Share a captured menu
`src/lib/storage.ts` notes SavedRestaurant was designed with `id` + `capturedAt` so a
"shared menus across users" V2 needs no migration, and `api/sync.ts` already persists
per-user data server-side. Phase 1 (S): Web Share API exporting the menu as plain text
from `ParsedMenu`. Phase 2 (M): server-stored share links so another MenuVoice user
gets the full structured/voice experience.
- **Why:** lets a sighted dining companion or a fellow blind friend get the menu the
  user already captured — "what does this place have?" answered before arriving.
- **Effort:** S (text share) / M (links).
- **Risk:** share links need an unguessable-id story and a read-only endpoint.

### 10. First-scan practice in onboarding
`OnboardingScreen.tsx` asks only name + allergies (deliberately minimal), but the
guided scanner (`src/lib/scanner.ts` — directional hints, countdown, best-shot
fallback) is novel and the user meets it cold at a real table. Add an optional third
step: a 60-second practice scan of anything flat, exercising the coaching loop with
no stakes, plus a one-line explanation of voice mode vs. VoiceOver browse mode.
- **Why:** the scanner's directional guidance ("move the menu to the left") only works
  if the user trusts and understands it; first contact shouldn't be in a dim
  restaurant with a waiter standing there.
- **Effort:** M.
- **Risk:** onboarding length — keep it skippable; the current two-question flow's
  brevity is a feature.

### 11. Price-range guidance in browse mode
`hidePrices` already exists on the profile and the chat prompt handles prices, but
browse mode can't answer "what's under $15" without a voice round-trip. Add a spoken/
visible per-category price summary ("Mains: $12 to $28") computed client-side from
`item.price`, and honor `hidePrices` in `MenuDocument` (it currently renders prices
regardless of the setting — check `ConversationScreen.tsx` MenuDocument).
- **Why:** budget anxiety is real when you can't skim; a category-level range answers
  the cheapest/most expensive question without asking out loud at the table.
- **Effort:** S (price parsing from strings like "$12.95" is the only fiddly part).
- **Risk:** prices are stored "as written" — parsing must tolerate ranges and "MP".

### 12. Scanner threshold tuning from real telemetry
PROGRESS.md flags that `LUM_DARK`, `SHARP_MIN`, `EDGE_MIN` in `src/lib/scanner.ts`
were "tuned on theory". The data to tune them already lands in Postgres: `capture/
guidance` and `capture/scanner_struggle` events (ANALYTICS.md). Query guidance-state
distributions and time-to-capture, then adjust thresholds; consider logging the
per-frame metric values in the guidance event metadata to make this measurable.
- **Why:** if the scanner nags or never auto-fires in real restaurant lighting, blind
  users abandon the camera path entirely — and it's the only path for paper menus.
- **Effort:** S (analysis + constant tweaks) once a few real sessions exist.
- **Risk:** needs real-device sessions in restaurant lighting first (the explicit
  LEFT OFF item in PROGRESS.md).

### 13. Housekeeping: dead code and the Browserless token
Delete `api/scrape.ts` (PROGRESS.md confirms the client no longer calls it) and
renew/verify `BROWSERLESS_TOKEN` — production smoke tests showed the JS-shell
fallback in `api/_menuCore.ts` appears inactive, so JS-heavy menu sites (Toast,
Square pages) only work via the find-by-name web_search path.
- **Why:** the URL path silently degrades for a large class of restaurant sites;
  dead routes are attack/maintenance surface.
- **Effort:** S.
- **Risk:** confirm nothing external hits /api/scrape before deleting.

### 14. Location-stamped saves → "You're at Luigi's — open their menu?"
Store lat/lng on `SavedRestaurant` at capture/find time (one new optional field in
`src/types.ts`; storage comment says the shape was built to extend), then on app open
compare current position against saved spots and offer one-tap reopen.
- **Why:** the fastest possible path to a menu at a repeat restaurant — zero
  navigation, the app recognizes where you are.
- **Effort:** M.
- **Risk:** depends on idea 5's geolocation permission groundwork; distance matching
  needs a generous radius (GPS indoors is rough).
