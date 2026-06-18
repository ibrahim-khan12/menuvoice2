# MenuVoice — Fixes & Open Work

> Last updated: 2026-06-18. Single source of truth for all open bugs, a11y issues,
> and pending work. Consolidates REVIEW.md, VOICEOVER-AUDIT.md, SMOKE-RESULTS.md,
> and PLAN-REMAINING.md. Completed history in PROGRESS.md. Feature backlog in IDEAS.md.

Effort: S = under 1h · M = 1–3h · L = half day+

## Execution status update - 2026-06-18

Verified with `npm run build` and `npm run a11y:audit` against Vite preview on
`http://localhost:4173`.

| Item | Status | Evidence | Remaining action |
| --- | --- | --- | --- |
| B1 | Partial | `ProfileContext` now syncs loaded/reset `appVoice` state into `speech.ts`; `speak()` and `coach()` were already gated. | Full first-use/page-entry announcement model from B6 still needs a dedicated pass. |
| B2 | Done | Onboarding step changes now return focus to the active step heading instead of dropping VoiceOver on `<body>`. Verified in the current `npm run build` and `npm run a11y:audit` pass. | Real iPhone VoiceOver confirmation is still worth doing with the broader manual sweep. |
| B3 | Partial | Settings name/dislike mic flows now update the `role="status"` region for permission, recording, transcription, and save/error states. | Login/Onboarding already have local announcers but still need a full Phase 2 verification pass. |
| B4 | Done | Capture scanner coaching now avoids double-speaking by silencing the duplicate live region path when app voice is already handling the prompt. Verified in the current `npm run build` and `npm run a11y:audit` pass. | Real-device scan flow remains the final confidence check. |
| B5 | Mostly code complete | Root loading text now has `role="status"`; `SavedScreen` cards use `role="group"`; Conversation uses `aria-disabled` plus no-op actions; Settings voice/spice pickers use radio semantics; transcribing labels and sign-out confirm were added; Find no longer auto-focuses; audit still passes with 0 violations. | Do one focused VoiceOver/manual pass across Conversation, Saved, and Settings to confirm behavior on device. |
| A1 | Code complete, manual check needed | Capture preview now uses actual video aspect ratio plus `objectFit: contain`; fallback zoom crop is applied to `captureFrame()`. Build passed. | Real portrait/landscape device comparison of preview vs saved JPEG. |
| A2 | Partial | Added camera zoom helpers, native zoom application, accessible zoom buttons, fallback preview scale, and matching centered capture crop. | Real iPhone fallback and Android native zoom checks. |
| A3 | Code complete, manual check needed | `src/index.css` now adds a compact landscape capture layout that moves controls beside the preview without overlap. Build and a11y audit both passed after the CSS change. | Real landscape phone/tablet capture check for reachability, VoiceOver order, and upright saved images. |
| B7 | Partial | Added `PauseProvider`, a global Pause/Resume control, pause-aware speech stop, and a registered listening-stop hook so speech/listening do not auto-restart while paused. | Manual mic and screen-reader verification is still needed on real devices. |
| B7a | Code complete, manual check needed | Conversation now lets empty-space taps interrupt speech, while preserving normal behavior on actual controls and keeping the explicit interrupt button. | Manual tap-interrupt testing with VoiceOver and touch exploration. |
| B9 | Code complete, manual check needed | Find screen no longer rejects non-comma searches; normalizes state names/abbreviations such as `Montclair New Jersey` to `Montclair, NJ`. | Voice/manual search checks with ambiguous one-word locations. |
| B10 | Partial | Name search results now require a touch confirmation before saving/opening. | Voice yes/no confirmation and next-match handling are not implemented. |
| C1 | Code complete | `_menuCore.ts` already used Browserless `Authorization`; legacy `api/scrape.ts` now does too. | Confirm whether `api/scrape.ts` is still deployed/live. |
| C2 | Code complete | `find-menu.ts` sanitizes direct search categories; `_menuCore.ts` now sanitizes parsed source categories too. | Add targeted API fixture tests if desired. |
| C5 | Code complete | `_menuCore.ts` now checks `content-length` and streams PDF/HTML bodies with byte caps before buffering. | Add synthetic oversized/chunked response test harness. |
| D2 | Code complete | `find-menu.ts` now uses fixed factual copy when `found=true` but no readable menu is extracted. | Production smoke after Browserless token renewal. |
| D3 | Blocked | Local response shape preserves `menu.incomplete`; production was not checked in this run. | Needs deployed URL/env access and known partial-menu curl checks. |

---

## Recommended execution order

1. **Code quick wins** (C1, C3) — safe, zero UX risk, clears security/reliability backlog
2. **VoiceOver friction** (B1, B2, B3) — P0 app-voice toggle, onboarding focus, mic feedback
3. **Camera** (A1 → A2 → A3) — must do in order; A1 is the foundation
4. **Code remainder** (C2, C4)
5. **VoiceOver polish** (B4)
6. **Ops** (D1–D3) — needs you for token renewal + real device

---

## A — Camera

### A1. Preview vs. actual capture range mismatch [S, MED RISK] ← do first
**Source:** PLAN-REMAINING, SMOKE-RESULTS  
**Problem:** Preview `<div>` uses `aspectRatio: 3/4` + `objectFit: cover` which crops the
video, but `captureFrame()` encodes the full `videoWidth × videoHeight`. Blind users frame
to what they hear coached, but the saved photo contains different content.  
**Files:** `src/screens/CaptureScreen.tsx` (preview box ~348-366), `src/lib/camera.ts` (`captureFrame`)  
**Fix (preferred):** `objectFit: contain`; set preview aspect ratio from actual track
(`video.videoWidth / videoHeight`) so what is shown equals what is captured. Letterbox with black.  
**Acceptance:** capture a page, compare saved JPEG to preview — identical framing. Test portrait and landscape.

### A2. Pinch-to-zoom + explicit +/- buttons [M, MED RISK]
**Source:** PLAN-REMAINING  
**Problem:** No zoom; seated users who cannot move the phone far away cannot fill the frame. Accessibility-critical.  
**Files:** `src/lib/camera.ts` (new `setZoom`/`getZoomRange`), `src/screens/CaptureScreen.tsx`  
**Fix:**
- Android Chrome: `track.getCapabilities().zoom` → `track.applyConstraints({ advanced: [{ zoom }] })`
- iOS Safari fallback: CSS `transform: scale(z)` on `<video>` for preview + matching center-crop in `captureFrame` (keep in lockstep with A1)
- UI: large `+` / `-` buttons (≥64px, aria-labels "Zoom in" / "Zoom out"), announce "Zoom 2x", earcon/haptic on change
- Reset per session (no persisted zoom — avoids surprise)

**Acceptance:** zoom in, capture, OCR still reads; preview and saved photo zoom together; works
(digital) on iOS and (native) on Android; VoiceOver announces level.

### A3. Landscape / horizontal capture [M, MED RISK]
**Source:** PLAN-REMAINING  
**Problem:** Phone can rotate but user cannot actually capture in landscape; wide menus don't fit portrait.  
**Files:** `src/screens/CaptureScreen.tsx`, `src/index.css`  
**Fix:** After A1 the preview already follows the real track aspect ratio, so a landscape sensor
previews landscape. Add `@media (orientation: landscape)` layout so controls sit beside the
preview instead of below (no overlap, touch targets ≥64px). Confirm EXIF/rotation: canvas
capture bakes in display orientation, so no rotated JPEGs.  
**Acceptance:** rotate to landscape, frame a wide menu, capture — saved photo is landscape and
upright; controls reachable; VoiceOver order still logical.

---

## B — VoiceOver / Accessibility

### B1. P0 — App TTS talks over VoiceOver on every screen entry [M, HIGH RISK]
**Source:** VOICEOVER-AUDIT P0-1  
**Problem:** Every screen calls `speak()` on mount at the same moment `Screen` focuses `<main>`,
causing two voices simultaneously. No global app-voice toggle exists.  
**Files:** `src/lib/speech.ts`, `src/state/ProfileContext.tsx` (add `appVoice: boolean`),
`src/screens/SettingsScreen.tsx` (toggle), plus every screen with mount-time `speak()`.  
**Fix:** Gate all `speak()` and `coach()` in `speech.ts`:
```ts
let appVoiceEnabled = true;
export function setAppVoice(on: boolean) { appVoiceEnabled = on; stopSpeaking(); }
export async function speak(text: string, voice?: string) {
  if (!appVoiceEnabled) return;
  ...
}
```
Announce on first launch: "If you use VoiceOver, you can turn off my voice in Settings."  
Ensure every spoken message also exists in the DOM (see B2, B3) so nothing is lost when app voice is off.

### B2. P1-3 — OnboardingScreen loses focus on step change [S, LOW RISK]
**Source:** VOICEOVER-AUDIT P1-3  
**Problem:** Tapping Next/"Let's begin" removes the focused button; focus falls to `<body>`, VoiceOver stranded.  
**Files:** `src/screens/OnboardingScreen.tsx:45-52`  
**Fix:**
```tsx
const stepHeadingRef = useRef<HTMLHeadingElement>(null);
useEffect(() => {
  if (step !== 'intro') stepHeadingRef.current?.focus();
}, [step]);
// In VoiceStep: <h2 tabIndex={-1} ref={headingRef}>{question}</h2>
```

### B3. P1-4 — Mic transcription feedback is TTS-only on Login, Onboarding, Settings [S, LOW RISK]
**Source:** VOICEOVER-AUDIT P1-4  
**Problem:** "I heard: …", "Name updated to X", mic errors go only through `speak()`. VoiceOver users get silence and must hunt to verify.  
**Files:** `src/screens/LoginScreen.tsx:117`, `src/screens/OnboardingScreen.tsx:163`, `src/screens/SettingsScreen.tsx:70,104`  
**Fix:** Add one status line per screen; route all spoken feedback through `announce()`:
```tsx
const [srStatus, setSrStatus] = useState('');
const announce = (msg: string) => { setSrStatus(msg); speak(msg); };
<p role="status" aria-live="polite" style={{ minHeight: 28 }}>{srStatus}</p>
```
Use `announce()` everywhere these screens call bare `speak()` for state changes, including mic
errors (LoginScreen:86,94,119; OnboardingScreen:141,149,165).

### B4. P1-8 — CaptureScreen: coach() + aria-live double-speak during scanning [S, LOW RISK]
**Source:** VOICEOVER-AUDIT P1-8  
**Problem:** Every scanner coaching message is spoken by `coach()` AND announced by VoiceOver
via `role="status"` — two voices saying the same sentence, repeatedly.  
**Files:** `src/screens/CaptureScreen.tsx:115-118`  
**Fix:** Gate the scanner-status live region off when app voice is on:
```tsx
<p role="status" aria-live={appVoice ? 'off' : 'polite'} ...>{status}</p>
```
Keep a separate live region for errors/analysis announcements that is always on.

### B5. P2 polish batch [S, LOW RISK]
**Source:** VOICEOVER-AUDIT P2  
Do in one pass:
- **P2-1** `src/App.tsx`: unused `#sr-announce` — wire as shared `announce()` target or delete
- **P2-2** `src/screens/SavedScreen.tsx:46-50`: add `role="group"` so `aria-label` is honored on iOS
- **P2-4** `src/screens/ConversationScreen.tsx:384-390,461,489-493`: use `aria-disabled` + no-op instead of `disabled` (prevents VoiceOver focus drop when button disables mid-interaction)
- **P2-5** `src/screens/SettingsScreen.tsx:150-177,294-320`: spice/voice pickers → `role="radiogroup"` / `role="radio"` / `aria-checked`
- **P2-6** `src/screens/SettingsScreen.tsx:133,223`: add "Transcribing, one moment" label when `working` state
- **P2-7** `src/screens/FindScreen.tsx:88`: remove `autoFocus` — keyboard pops while VoiceOver is mid-announcement; let users reach the input one swipe after the heading
- **P2-8** `src/screens/SettingsScreen.tsx:327-336`: sign-out → two-tap confirm (arm then confirm), same pattern as SavedScreen delete
- **P2-10** `src/App.tsx:46-52`: root loading `<p>` → add `role="status"`

---

### B6. First-use guidance and page-change announcement model [M, HIGH RISK]
**Source:** User field-testing notes, 2026-06-16  
**Problem:** The app has not made a clear product decision for first-use speech. Blind users may hear overlapping app speech and VoiceOver, but if app speech is muted they still need reliable page-change and state-change announcements. Users also need first-run instruction for actions such as Analyze, Browse mode, and when to turn on or use a screen reader.  
**Fix:** Define one consistent announcement model:
- Every route/screen change updates a stable heading and a `role="status"`/live region with a short page-change message.
- App TTS is optional and never the only source of guidance.
- First-use tips explain the current mode and the next primary action in plain speech and DOM text, for example "Write your answer in the box", "Tap Analyze to read this image", or "Turn on your screen reader when browsing the menu."
- No emojis in spoken output.

**Acceptance:** With app voice on, no duplicate/overlapping VoiceOver speech on screen entry. With app voice off, VoiceOver still announces screen changes, mode changes, and required next actions.

### B7. Pause all app speech and listening [M, HIGH RISK]
**Source:** User field-testing notes, 2026-06-16  
**Problem:** Browse mode and other flows can keep listening or speaking while the user needs quiet control. There is no obvious pause control that stops both speech output and microphone/listening behavior.  
**Fix:** Add a global Pause control that:
- Stops current app TTS immediately.
- Stops active speech recognition/listening immediately.
- Prevents automatic listening from restarting until resumed.
- Is reachable by VoiceOver, has a clear label, and preserves the user's current screen.
- Explains itself on first use.

**Acceptance:** While paused, the app does not speak, does not listen, and does not reopen the mic during browse mode or conversation mode. Resuming restores the previous mode intentionally.

### B7a. Tap anywhere to interrupt app speech [S, HIGH RISK]
**Source:** User field-testing notes, 2026-06-17  
**Problem:** During app speech, the user currently has to find the specific interrupt/talk control. For a blind or low-vision user, that makes it too hard to stop long speech quickly. When MenuVoice is speaking, a tap anywhere on the main conversation screen should interrupt the speech and start the user's turn.  
**Fix:** In the conversation/browse speech surfaces, make the full screen an interrupt target while `phase === 'speaking'`:
- Any tap/click outside an explicitly interactive control calls the same barge-in path as the current interrupt button: `stopSpeaking('bargein')` then start listening.
- Do not steal taps from real controls, links, settings, back buttons, or form fields.
- Keep the visible button and VoiceOver label for discoverability, but do not require precise targeting.
- Announce the mode in plain language, for example "MenuVoice is speaking. Tap anywhere to interrupt."

**Acceptance:** While MenuVoice is speaking on the conversation screen, tapping empty space anywhere on the screen stops speech and opens the mic. Tapping a real control still performs that control's normal action. VoiceOver users still have an explicit labeled interrupt control.

### B7b. Announce browser and device permission prompts [S, HIGH RISK]
**Source:** User field-testing notes, 2026-06-17  
**Problem:** Browser permission prompts for microphone, camera, location, notifications, or other device access can appear visually without enough app guidance. Blind and low-vision users may not know that the browser is waiting for an Allow/Block decision, so the app can seem frozen.  
**Fix:** Before every permission request, announce what is about to happen through app speech when enabled and through a `role="status"` live region:
- Use plain, direct copy, for example "Your browser is asking for microphone permission. Choose Allow so MenuVoice can hear you."
- Keep the same message visible in DOM text near the current task.
- If permission is denied or dismissed, explain the next step in plain language and keep the user on the same task.
- Cover microphone, camera/photo capture, location, and any future browser/device permission requests through one shared helper if practical.
- Do not rely only on color, icons, or visual browser UI.

**Acceptance:** When a browser permission prompt appears, a blind user hears or receives a VoiceOver announcement explaining which permission is needed and what to choose. If the prompt is denied or dismissed, the app announces the recovery path without silently failing.

### B8. AI-normalized allergy entry and inferred allergen warnings [M, HIGH RISK]
**Source:** User field-testing notes, 2026-06-16  
**Problem:** Allergy entry currently risks accepting misspellings or one-shot dictated phrases too literally. A user might say "peanuts and shellfish" with errors or in one sentence, and the app should normalize that into common allergy categories rather than saving raw, misspelled text. The app should also warn from likely ingredient assumptions when a cuisine or dish type commonly contains an allergen, while making clear that it is a warning, not a verified claim.  
**Fix:** Add an allergy parser/normalizer:
- Convert dictated or typed allergy text into canonical common allergens where possible.
- Ask for confirmation when uncertain instead of silently saving a risky guess.
- Preserve user-entered custom allergies that do not map cleanly.
- During menu analysis/conversation, warn when an item or cuisine commonly contains a saved allergen or cross-contact risk, even if the exact ingredient list is incomplete.
- Keep warning copy conservative, for example "This may contain peanuts. Ask the restaurant before ordering."

**Acceptance:** Misspelled or dictated allergy entries normalize to common allergen categories, uncertain mappings request confirmation, and menu answers surface conservative allergen warnings without making unverified promises.

### B9. Location input should not require comma formatting [S, MED RISK]
**Source:** User field-testing notes, 2026-06-16  
**Problem:** The town/location flow requires users to type a comma-formatted location before sending to the API. That is brittle for voice input and confusing for blind users who may not know the exact required punctuation.  
**Fix:** Accept natural location input without requiring a comma. Before sending to the API, normalize likely "town state" or "town NJ" style input into the format the API expects. If clarification is needed, ask in plain language rather than telling the user to add punctuation.  
**Acceptance:** Inputs like "Montclair New Jersey", "Montclair NJ", and "Montclair" do not fail solely because they lack a comma. The app either normalizes them or asks one clear follow-up question.

### B10. Confirm restaurant match before opening menu flow [M, HIGH RISK]
**Source:** User field-testing notes, 2026-06-16  
**Problem:** When the app finds a restaurant, it can move forward before confirming that the found result is actually the restaurant the user wanted. A wrong restaurant means the user may browse, save, or ask about the wrong menu without realizing it.  
**Fix:** Before opening the menu or saving the restaurant, present a confirmation step with the restaurant name, town/address when available, and a clear yes/no path. The user should be able to answer by voice or touch. If they say no, return to the search/location prompt or offer the next likely match.  
**Acceptance:** After restaurant lookup, the app asks a clear confirmation such as "I found Mario's Pizza in Montclair. Is this the restaurant you want?" It only proceeds after a yes. A no does not save or open that restaurant.

---

## C — Code / Security

### C1. Browserless token in URL query string [S, LOW RISK]
**Source:** REVIEW.md #13  
**Problem:** `?token=${BROWSERLESS_TOKEN}` ends up in intermediary/proxy/error logs.  
**Files:** `api/_menuCore.ts:94`  
**Fix:** `headers: { Authorization: 'Bearer ' + BROWSERLESS_TOKEN }` instead of `?token=`. Never log `res.url`.

### C2. Unvalidated LLM categories crash client [S, LOW RISK]
**Source:** REVIEW.md #2  
**Problem:** `api/find-menu.ts` forwards `result.categories` verbatim. A category missing
`items` throws `TypeError` in the client — which FindScreen then speaks aloud to the blind user as an error.  
**Files:** `api/find-menu.ts:100-110`  
**Fix:**
```ts
const categories = (Array.isArray(result?.categories) ? result.categories : [])
  .filter((c: any) => c && typeof c.name === 'string' && Array.isArray(c.items))
  .map((c: any) => ({
    name: c.name,
    items: c.items.filter((it: any) => it && typeof it.name === 'string'),
  }));
```

### C3. Telemetry multi-tab + pre-init queue race [S, LOW RISK]
**Source:** REVIEW.md #16  
**Problem:** Two tabs both `restore()` the same localStorage queue and double-send it.
`_queue = restore()` discards events tracked before `initTelemetry()` runs.  
**Files:** `src/lib/telemetry.ts:113-117`  
**Fix:** `_queue = [...restore(), ..._queue]`; namespace queue key per session id
(`QUEUE_KEY + ':' + sid()`); clean stale session keys on init.

### C4. iOS Safari: coach() utterances silently dropped [M, HIGH RISK]
**Source:** REVIEW.md #6  
**Problem:** `coach()` calls `speechSynthesis.cancel()` then `speak()` synchronously.
iOS WebKit swallows the new utterance — the guided scanner's coaching, countdown, and
"Got it" confirmations randomly never play. Core accessibility loop goes silent on
the primary platform.  
**Files:** `src/lib/speech.ts` (`coach()`)  
**Fix:**
```ts
window.speechSynthesis.cancel();
setTimeout(() => {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}, 60);
```

### C5. PDF size checked only after full body buffered [S, LOW RISK]
**Source:** REVIEW.md #8  
**Problem:** `await response.arrayBuffer()` downloads unbounded content before the 15 MB check.
A hostile or chunked endless stream can OOM the serverless function. Same issue on the HTML
branch (`response.text()` is unbounded, sliced to 60k only afterwards).  
**Files:** `api/_menuCore.ts:134-139`  
**Fix:** Pre-check `Number(response.headers.get('content-length') || 0) > MAX_PDF_BYTES`
first; read via `response.body.getReader()` and abort once the cap is exceeded.

---

## D — Ops (needs human action or real device)

### D1. Renew BROWSERLESS_TOKEN [BLOCKED on you]
**Problem:** Production smoke tests show JS-rendered chain restaurants (Olive Garden, Panda Express,
McAlister's Deli) fail fast with friendly 422s. Their menus ARE online — the Browserless
JS-render fallback in `api/_menuCore.ts` appears inactive (token exhausted or expired).
**Action:** Renew token in Vercel env → re-run `node scripts/smoke-restaurants.mjs` → update SMOKE-RESULTS.md.

### D2. Fix error copy for chain-restaurant failures [S, after D1]
**Problem:** When `found=true` but no items extracted, the model-generated `reason` goes to
users. Panda Express run 2 leaked prompt language ("without inventing missing entries"). Olive
Garden/McAlister's say "their menu does not seem to be posted online" — factually wrong.  
**Files:** `api/find-menu.ts`  
**Fix:** Replace model-generated reason with fixed, honest copy. Never claim "not posted
online" when `found=true`. Candidate: "I found this restaurant but couldn't read their menu
online. Try scanning the physical menu."

### D3. Verify `incomplete` flag reaches production [S]
**Problem:** SMOKE-RESULTS showed `incomplete` never appeared in any successful response
(9 successes across two runs). Lou Malnati's returned 10/58 items with no incomplete signal.
Either a stale deploy predating the flag, or it's being stripped somewhere.  
**Action:** POST a known-partial menu to production `/api/find-menu` and `/api/menu-from-url`;
confirm `menu.incomplete` is present in the response JSON.

### D4. Real-device VoiceOver pass [you + me]
**Problem:** Heading-rotor, camera zoom/landscape, and P0/P1 VoiceOver fixes need a real
iPhone + VoiceOver test. Headless browser catches runtime errors and screenshots, but actual
rotor behavior requires real hardware.  
**Timing:** Schedule after A and B workstreams land. ~20 min.

### D5. Scanner threshold calibration [deferred]
**Problem:** `LUM_DARK`, `SHARP_MIN`, `EDGE_MIN` in `src/lib/scanner.ts` were tuned on theory.
Telemetry already logs `capture/guidance` and `capture/scanner_struggle` events.  
**Action:** After a few real restaurant sessions, query the guidance-state distributions from
Postgres and adjust constants. Consider logging per-frame metric values in the guidance event
metadata to make tuning measurable.

---

## E — Content

### E1. Website em-dashes [S, LOW RISK]
**Problem:** App-facing copy is em-dash-free (VoiceOver rule). Website marketing copy is not.  
**Files:** `public/website/index.html` (~line 11). Verify which website dir is actually served.  
**Fix:** Replace `—` with periods or restructured sentences. Apply no-AI-slop content rule
(no salesy language, no unverified claims) while in there. Skip `dist/website/*` — regenerated.

### E2. Code comments + doc em-dashes [optional]
~280 occurrences across `src/*` comments, `api/*` comments, and planning docs. Not user-facing,
do not affect VoiceOver. Skip unless you want consistency.

---

## Done (reference)

- ✅ Browse mode VoiceOver heading hierarchy — each dish is one h3 rotor stop
- ✅ Speaking page redesign — bounded convo area, no overlap, AAA contrast
- ✅ Home page redesign — single column, non-overlapping buttons, h1 heading
- ✅ Allergy spellcheck — offline local edit-distance, wired into Settings + Onboarding
- ✅ Incomplete-menu banner + "add photos" supplement flow
- ✅ Unified Find screen — name OR URL in one box, one in-flight guard
- ✅ UrlScreen removed (dead code, 5bac3fd)
- ✅ SSRF guard — assertPublicUrl() in _menuCore.ts, re-checked after redirects
- ✅ FindScreen re-entrancy — inFlightRef guard stops parallel find() calls
- ✅ Telemetry batch wedging — 60 KB cap, split or drop poison event
- ✅ events.ts CORS hardening, size caps, Promise.allSettled, row cap 50
- ✅ find-menu timeout budget — 35s search, 55s total, friendly error on timeout
- ✅ Scanner: struggle timer, heartbeat nag, stop() cleanup (REVIEW #9/10/11)
- ✅ REVIEW #12 — events.ts allSettled, client_ts/duration_ms coercion
- ✅ REVIEW #14 — menu-from-url dead conditional removed
- ✅ VoiceOver P0-2 — recording phase aria-live off (no VoiceOver into open mic)
- ✅ VoiceOver P0-3 — FindScreen + CaptureScreen reassurance in role="status"
- ✅ VoiceOver P1-1 — heading order, single h1, no duplicate restaurant heading
- ✅ VoiceOver P1-2 — HomeScreen h1 "MenuVoice"
- ✅ VoiceOver P1-5 — SavedScreen: status region, two-tap delete confirm, focus return
- ✅ VoiceOver P1-6 — Settings: allergy save announced in DOM and aloud
- ✅ VoiceOver P1-7 — Find submit reachable when field is empty
- ✅ VoiceOver P2-3 — duplicate phase aria-label removed
