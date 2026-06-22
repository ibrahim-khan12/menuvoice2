# MenuVoice — Fixes & Open Work

> Last updated: 2026-06-22. Single source of truth for all open bugs, a11y issues,
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
| B5 | Mostly code complete | Root loading text now has `role="status"`; `SavedScreen` cards use `role="group"`; Conversation uses `aria-disabled` plus no-op actions; Settings voice/spice pickers use radio semantics; transcribing labels and sign-out confirm were added; Find no longer auto-focuses; the current build and audit still pass with 0 violations. | Do one focused VoiceOver/manual pass across Conversation, Saved, and Settings to confirm behavior on device. |
| A1 | Code complete, manual check needed | Capture preview now uses actual video aspect ratio plus `objectFit: contain`; fallback zoom crop is applied to `captureFrame()`. Build passed. | Real portrait/landscape device comparison of preview vs saved JPEG. |
| A2 | Partial | Added camera zoom helpers, native zoom application, accessible zoom buttons, fallback preview scale, and matching centered capture crop. | Real iPhone fallback and Android native zoom checks. |
| A3 | Code complete, manual check needed | `src/index.css` now adds a compact landscape capture layout that moves controls beside the preview without overlap. The current build and a11y audit both pass with that CSS in place. | Real landscape phone/tablet capture check for reachability, VoiceOver order, and upright saved images. |
| B7 | Partial | Added `PauseProvider`, a global Pause/Resume control, pause-aware speech stop, and a registered listening-stop hook so speech/listening do not auto-restart while paused. | Manual mic and screen-reader verification is still needed on real devices. |
| B7a | Code complete, manual check needed | Conversation now lets empty-space taps interrupt speech, while preserving normal behavior on actual controls and keeping the explicit interrupt button. | Manual tap-interrupt testing with VoiceOver and touch exploration on a real device is still needed. |
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

### B6a. Demo mode for guided testing and outreach [M, MED RISK]
**Source:** User backlog note, 2026-06-22
**Problem:** Testers and demo audiences can hit fragile live-search, live-menu, microphone, or restaurant-site failures before they understand the intended MenuVoice flow. That makes feedback hard to interpret: the person may be reacting to a blocked restaurant lookup instead of the core voice-first menu experience.
**Fix:** Add a clearly labeled demo mode that uses a known sample restaurant/menu and walks through the same voice-first screens without requiring a live restaurant search or fresh menu extraction. Keep it honest: the app should say it is using a sample menu, not imply the restaurant data is live. Demo mode should still exercise VoiceOver navigation, app speech, allergy warnings, browse mode, conversation, and pause/resume controls.
**Acceptance:** A tester can open MenuVoice, start demo mode, hear that it is a sample menu, browse and ask questions, test pause/resume, and exit back to the normal app. No user-facing demo copy makes claims about live restaurant accuracy.

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

### B10a. Fix Find reliability or temporarily simplify it to restaurant-name lookup [M, HIGH RISK]
**Source:** User backlog note, 2026-06-22; tester failures in `APP-TESTER-USAGE-REPORT.md`
**Problem:** Find is still the first real product path many testers use, and live restaurant/menu lookup can fail in ways that sound like the restaurant has no online menu even when the app just could not read it. If the full search flow is not reliable enough for demos or outside testers, it should be narrowed temporarily instead of letting users hit confusing failures.
**Fix:** Pick one of two paths before the next tester/demo round:
- Fix the full Find flow so restaurant name, location, chain results, and unreadable-menu failures produce accurate, actionable outcomes.
- Or temporarily simplify Find to restaurant-name-only lookup with clear copy and pause/disable brittle location, URL, or broad web-search behavior until it is reliable.

In either path, never say a menu is not posted online unless the app has actually verified that. Prefer: "I found this restaurant but could not read its menu online. Try scanning the physical menu."

**Acceptance:** A tester can search by restaurant name without being misled by false "not online" failures. If broader search modes are paused, the UI and VoiceOver copy make that limitation explicit and offer capture/demo mode as alternatives.

### B11. Copy audit for VoiceOver-first screens [S, MED RISK]
**Source:** User field-testing notes, 2026-06-18  
**Problem:** Several screens still use extra helper copy, jargon, or overly long button labels and hints. Blind and low-vision users should hear only the words that explain the next action or a real state change. Extra copy slows VoiceOver navigation and makes the app harder to parse.
**Fix:** Review every visible label, helper line, button label, and spoken button hint on the app screens:
- Remove filler and repeated explanations.
- Keep only action guidance, safety guidance, and state-change feedback.
- Prefer task words over product or technical words, for example "Read menu" instead of "Analyze".
- Make the visible label carry the core meaning so the `aria-label` hint can stay short.
- Re-test Home, Find, Onboarding, Capture, Conversation, Saved, Login, and Settings with VoiceOver running.

**Acceptance:** Each screen can be navigated by VoiceOver without unnecessary copy, while still explaining what to do next anywhere the action would otherwise be unclear.

---

## Bx — Menu extraction workflow

### B12. Hybrid OCR + LLM extraction pipeline [L, HIGH RISK]
**Source:** User backlog review, 2026-06-18  
**Problem:** Menu extraction still asks the model to do too much in one step. The app can already parse menu URLs and camera captures, but it depends too heavily on end-to-end model interpretation instead of first establishing whether the source is readable, rotated correctly, text-dense enough, or obviously partial. That makes bad captures, PDFs, and image-heavy menus less predictable than they need to be.  
**Why this matters:** This is the main reliability upgrade for the product. It improves both live capture and imported menus, reduces wasted model calls on unreadable input, and creates the structure needed for better confidence handling, partial-menu handling, and later evaluation fixtures.  
**Files likely involved:** `src/screens/CaptureScreen.tsx`, `src/lib/scanner.ts`, `src/lib/openai.ts`, `api/_menuCore.ts`, `api/menu-from-url.ts`, `src/types.ts`, plus any new shared helper such as `src/lib/menuPrepass.ts` or `api/_menuPrepass.ts`.  
**What needs to be done:**
- Add a pre-pass result object that is produced before the structured menu extraction call. It should include fields such as `readability`, `blur`, `orientation`, `hasText`, `likelyPartial`, `languageHint`, and normalized `textBlocks` when available.
- For camera capture, reuse the existing scanner or capture signals where possible instead of inventing a second independent quality system.
- For URL and PDF flows, run OCR or text normalization before menu reasoning so the LLM receives cleaner text and clearer context about what kind of source it is reading.
- Split the current "extract everything" flow into two stages:
  1. inspect and normalize the source
  2. reason over the normalized source into the existing `ParsedMenu` shape
- Expand `ParsedMenu` or adjacent metadata only where it helps downstream decisions. Do not bloat the spoken UI with raw technical fields.
- Preserve existing saved-menu behavior, but persist enough extraction metadata to support later QA and reprocessing.
- Add fixture coverage for clean menu photos, blurry photos, rotated photos, cropped partial menus, PDFs, and image-heavy restaurant pages.
**Implementation plan:**
1. Define a stable pre-pass contract and where it lives in shared types.
2. Route camera captures through that contract first, using existing scanner signals as the first data source.
3. Route URL and PDF parsing through the same contract so imported menus and scanned menus converge before final extraction.
4. Update extraction prompts and helper functions to consume pre-pass output instead of raw input alone.
5. Add telemetry for pre-pass outcomes and extraction fallbacks, but avoid storing sensitive raw images beyond current policy.
6. Add regression fixtures and confirm that failure states produce actionable recovery copy.
**Fix (preferred):**
- Create one shared menu-ingestion pipeline:
  - source acquisition
  - pre-pass quality and OCR analysis
  - structured extraction
  - conversation opening summary
- Keep the output contract conservative and explicit about uncertainty.
- Reuse the existing `find` and `capture` entry points instead of adding a third parallel ingestion path.
**Acceptance:**
- A blurry or text-poor menu is rejected or coached before a full extraction call.
- Rotated, PDF, and image-based imports use the same normalized extraction contract.
- Successful captures or imports produce fewer empty or malformed categories than the current flow.
- The pipeline exposes enough metadata to support partial-menu warnings and future eval fixtures without forcing technical details into the spoken UX.

### B13. Post-extraction opening summary should be useful, not numeric [M, HIGH RISK]
**Source:** User backlog review, 2026-06-18  
**Problem:** The app needs a post-extraction checkpoint before it starts reading the menu, but raw counts such as "5 sections" or "42 items" do not help the user make a decision. That adds noise. The user only needs to know which restaurant menu was opened and whether anything important appears to be missing or unreliable.  
**Why this matters:** The checkpoint idea is right, but the copy target was wrong. The summary should improve confidence and control, not sound like internal diagnostics.  
**Files likely involved:** `src/lib/openai.ts` (`buildOpeningLine` and related helpers), `src/screens/ConversationScreen.tsx`, `src/types.ts`, and any extraction metadata introduced by B12.  
**What needs to be done:**
- Replace count-heavy opening summaries with short restaurant-first copy.
- Default opening should identify the restaurant and move straight into the next action, for example: "This is the menu for Luigi's. What would you like to hear?"
- Only mention extraction problems when they are material, for example:
  - the menu looks partial
  - prices are missing in many places
  - a section is unreadable
  - the source may not be the full menu
- Keep technical counts out of the spoken default path unless a future debug or admin mode needs them.
- Give the user clear next actions when something is missing, for example: add another photo, try a different link, or ask for the section that was captured.
**Implementation plan:**
1. Define the decision rules for when extraction quality is good enough to stay quiet versus important enough to mention.
2. Refactor the opening-line builder so it consumes restaurant name plus extraction-quality flags, not just category counts.
3. Update conversation entry so the first spoken response is short and restaurant-first.
4. Add tests or fixtures for:
   - complete menu
   - clearly partial menu
   - mostly missing prices
   - low-confidence or unreadable sections
5. Verify that the UI still offers recovery actions without overwhelming the default happy path.
**Fix (preferred):**
- Use copy shaped like:
  - Normal: "This is the menu for [restaurant]. What would you like to hear?"
  - Partial: "This is the menu for [restaurant], but some parts look missing. I can read what I found, or you can add another photo."
  - Weak source: "I found part of the menu for [restaurant], but this source does not look complete. Want to hear what I found or try another menu?"
- Do not announce section counts or item counts in the default user flow.
**Acceptance:**
- On good captures or imports, the opening summary names the restaurant and moves on without numeric counts.
- On materially incomplete captures or imports, the app clearly says something important is missing and offers a recovery path.
- Users are not exposed to internal extraction diagnostics unless the omission actually affects what they can trust or do next.

### B14. Organized menu mode should show allergy information [M, HIGH RISK]
**Source:** User field-testing note, 2026-06-21
**Problem:** The organized menu view, where items are grouped under section headers, can hide or fail to surface allergy/allergen information that is available elsewhere in the menu experience. A user browsing by headers needs the same conservative allergy warnings and unknown-allergen status without switching modes or asking a separate question.
**Why this matters:** Organized mode is likely the easiest way for blind and low-vision users to scan a menu. If allergy details are missing there, the mode can feel complete while omitting safety-critical information.
**Files likely involved:** `src/screens/ConversationScreen.tsx`, `src/lib/menuData.ts`, `src/lib/openai.ts`, `src/types.ts`, and any component/helper that renders the grouped or header-organized menu view.
**What needs to be done:**
- Identify the mode/view that organizes menu content by headers or sections.
- For each dish, surface relevant allergy information already known from parsed menu data, saved user allergies, inferred warnings, or unknown-allergen metadata.
- Keep copy conservative: distinguish verified menu disclosures, likely/inferred warnings, user-specific saved allergy matches, and unknowns.
- Do not claim an item is safe. Use wording such as "Contains peanuts per menu", "May contain shellfish; ask staff", or "Allergens unknown".
- Make the allergy line reachable by VoiceOver in the same navigation order as the item name, price, and description.
**Acceptance:**
- In the organized/header menu mode, items with known or likely allergen information expose that information inline or immediately after the item.
- Items with unknown allergen status do not silently appear allergy-safe.
- VoiceOver users can hear the allergy information while browsing by section headers without leaving organized mode.

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

### D6. Investigate Joey/Joseph tester failure path [M, HIGH RISK]
**Source:** User backlog note, 2026-06-22; `APP-TESTER-USAGE-REPORT.md`
**Problem:** The strongest outside-tester session hit multiple real failures: Olive Garden lookup failed, McDonald's in Troy Alabama failed with misleading "menu not posted online" style copy, The Butcher's Daughter failed once before succeeding, and a capture/OCR extraction failed before Annie's Cafe succeeded. These are exactly the errors a real blind user would experience during first use.
**Action:** Pull the production telemetry/events for that tester session, group the failures by flow, and convert each reproducible issue into a concrete bug or code fix:
- Find/search failures for chains and local restaurants.
- Misleading unreadable-menu copy.
- Capture/OCR extraction failure before success.
- Any duplicate/bad login email handling from the recorded duplicated email value.

**Acceptance:** Each tester failure has either a verified root cause and fix, a reproduction command/fixture, or a documented external blocker. The final notes should distinguish app bugs from restaurant-site limitations.

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

### E3. Fix public website before more outreach [M, MED RISK]
**Source:** User backlog note, 2026-06-22
**Problem:** The public website is part of the first impression for testers, partners, and outreach recipients, but the current open work only calls out em-dashes. The site also needs a full factual/content and deployment pass so it matches the actual product and does not overpromise.
**Files:** `website/`, `public/website/index.html`, `menuvoice-site/README.md`, and the Vercel project serving `menuvoice.avitaldrel.com`.
**Fix:** Review the live-served website, identify which source directory controls it, and make one grounded pass:
- Remove salesy or unverified claims.
- Make the product offer clear without fluff.
- Ensure links from the website into the app work.
- Ensure the demo section does not imply live data unless it is actually live.
- Verify the deployed domain after push; do not treat a GitHub push as proof the public site changed.

**Acceptance:** `menuvoice.avitaldrel.com` reflects the edited source, has no misleading claims, links correctly into the app, and uses factual copy aligned with the current MenuVoice build.

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
