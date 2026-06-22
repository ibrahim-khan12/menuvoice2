# MenuVoice — Build Notes: V1 Baseline + Everything We Added

## What V1 Had (the baseline commit, May 31 2026)

- React + Vite PWA, single-page app, all screens in place as shells
- Camera capture → GPT-4o Vision → structured menu JSON
- OpenAI TTS (`tts-1-hd`) for audio playback; browser `speechSynthesis` fallback
- Whisper transcription for voice input (via `MediaRecorder`)
- Basic conversation loop on `ConversationScreen`
- `ProfileContext` with localStorage persistence (name, allergies, cuisines liked)
- `SavedScreen` listing previously scanned restaurants
- `SettingsScreen` for preferences (allergies, preferred foods)
- Voice-first onboarding flow
- Basic theme (`theme.ts`) and component library (`components.tsx`)
- `nav.ts` custom navigation stack (no React Router)
- OpenAI key client-side only (exposed in browser, dev only)

---

## Features Added on Top of V1

### 1. Serverless API Proxy (Vercel)
**Commit:** `6720ae3`  
All OpenAI calls moved server-side. The client never sees `OPENAI_API_KEY`. Four Vercel functions: `/api/chat`, `/api/tts`, `/api/transcribe`, `/api/scrape`. Local dev still works via `VITE_OPENAI_API_KEY` in `.env` — the dual-path routing in `openai.ts` handles both cases transparently.

### 2. Full Voice Control Across All Screens
**Commit:** `35b4734`  
`useVoiceNav` hook (`src/hooks/useVoiceNav.ts`) — a reusable keyword-matching voice command layer. Any screen can register a command list with keywords; the hook records audio, transcribes with Whisper, and dispatches to a handler. Used on `HomeScreen`, `CaptureScreen`, `SettingsScreen`.

### 3. Voice-First Onboarding + Order Memory
**Commit:** `c3934d7`  
`OnboardingScreen` speaks each step aloud and collects name/allergies/preferences by voice. After each conversation, `extractSessionLearnings()` sends the full transcript to GPT and extracts what the guest decided to order, liked, and disliked — then merges those into the profile so future visits get personalized recommendations.

### 4. Auto-Extract Restaurant Name + Repeat Command
**Commit:** `6169941`  
GPT vision now extracts the restaurant name from the menu photos if it's visible. The capture screen prefills the name field automatically. The conversation loop recognizes "repeat that / say that again / pardon" and replays the last assistant turn without hitting the LLM.

### 5. Voice Allergy Management + Help Command in Settings
**Commit:** `82a4383`  
`SettingsScreen` accepts voice commands for adding/removing allergies by name ("add allergy shellfish", "remove allergy peanuts"). Full voice help menu: say "help" to hear all available commands. Dislikes can also be added/removed by voice.

### 6. Skip Button + Pulse Animations
**Commit:** `bfa0d2f`  
"Skip" button interrupts TTS mid-sentence and immediately starts the mic. Animated speaking bar during TTS and a pulsing border during recording give sighted users a visual cue. These also serve as focus targets for partial vision users.

### 7. Earcon Audio Cues
**Commit:** `d93250d`  
Web Audio API earcons (no audio files, zero latency): ascending double-ping = mic open, single descending ping = mic closed, low tone = error. Also: `earconTick()` plays rising tones as the auto-capture steadiness bar fills (critical feedback for blind users who can't see the progress indicator), and `earconCapture()` plays a shutter-click when the photo fires.

### 8. Auto-Stop Recording via Silence Detection
**Commit:** `aee33cd`  
Voice Activity Detection (`src/lib/vad.ts`) using Web Audio `AnalyserNode` RMS. After 3 seconds of silence, the recording auto-submits. Max recording cap of 30 seconds prevents runaway sessions.

### 9. Robust Uploads + Token Pruning + Storage Quota Handling + Offline PWA
**Commit:** `67a6f08`  
- Library photo uploads: multi-file picker, JPEG/PNG compression via canvas
- Conversation history pruning: keeps first 2 turns + last 18 to cap token cost on long sessions
- `localStorage` quota: if storage is full, oldest saved restaurants are dropped one-by-one until it fits
- Service worker / offline PWA: the app shell is cached and works offline; only AI calls need a network

### 10. SettingsScreen Voice Controls + Item Count in Opening Line + Onboarding Earcons
**Commit:** `7dc90df`  
The opening line of every conversation now says "I found 3 sections and 24 items on this menu…" (total item count included). Onboarding earcons confirm each step. Settings reads aloud the current state on mount ("Prices are currently shown. Voice is shimmer. Spice tolerance is medium.").

### 11. Menu from Website (URL Screen)
**Commit:** `69c2ea9`  
New `UrlScreen`: user pastes a restaurant website URL. `/api/scrape` fetches the page server-side (avoiding CORS), strips to text, and passes it to GPT for menu extraction. If the page is image-heavy or JavaScript-rendered, the scraper falls back to a rendered screenshot. Same conversation flow as after photo capture; TTS tells the user it's from the website and may not be 100% current.

### 12. Browse Mode (Silent Semantic Navigation)
**Commit:** `8786708`  
`BrowseScreen`: renders the full parsed menu as semantic HTML (h1 = restaurant, h2 = category, h3 = item). Designed for VoiceOver's heading rotor — the user can jump section-to-section and item-to-item without any audio from the app. Reachable from the conversation screen via "Browse menu silently". A "Talk to MenuVoice" button switches back to voice mode.

### 13. Sign Out Button
**Commit:** `d5d38db`  
Settings has a "Sign out" button (danger tone) that calls `reset()` on `ProfileContext`, clears localStorage, and returns to `LoginScreen`.

### 14. Auto-Capture Controller (`autocapture.ts`)
Built into V1 code but fully wired in later commits.  
Runs a `requestAnimationFrame` loop analyzing the camera frame for: brightness (rejects too-dark/too-bright), content density (rejects frames that look blank), and steadiness (requires N consecutive stable frames). Coaches by voice at each step ("Move closer", "Hold still…", etc.). Falls back to manual mode if it can't capture after ~45 seconds. The earcon tick pitch rises as the steadiness counter fills — blind users hear how close the auto-shutter is.

### 15. Web Speech API Voice Loop (Replaces MediaRecorder + VAD)
**Commit:** `49abe83`  
`SpeechManager` class using `webkitSpeechRecognition` / `SpeechRecognition`. The old path (MediaRecorder → Whisper → transcription) had a fatal flaw on iOS: the AudioContext analyser reads near-zero RMS when the phone's echo cancellation is active, so the silence detection never fired. Web Speech API uses the OS-level recognizer and has built-in silence detection. 2-second silence timer auto-submits the transcript. A "Done talking" button lets users submit early.

### 16. iOS Audio Unlock
**Commit:** `b9ef09c`  
`audioUnlock.ts`: iOS/Safari blocks all programmatic audio until the first user gesture. `unlockAudio()` must be called synchronously inside a tap. It: resumes/creates a shared `AudioContext` (plays a silent buffer), primes `speechSynthesis` with an empty utterance, and plays+pauses a muted `<audio>` element so later blob playback (OpenAI TTS) is allowed. Called from every first-tap button across the app. The shared `AudioContext` is reused by earcons — creating a new one outside a gesture would also be blocked.

### 17. `isSpeaking()` Guard on `coach()`
**Commit:** `a132c25`  
`coach()` (the free, instant browser voice used for auto-capture guidance) now checks `isSpeaking()` before speaking. Previously, if the main OpenAI TTS was playing and `coach()` fired from a timer, both voices played simultaneously. The guard silences `coach()` whenever the primary TTS channel is active.

### 18. Cloud Sync (`/api/sync`)
Built as part of the storage refactor.  
Profile + saved restaurants are pushed to a Vercel KV store on every save. On login, the app pulls cloud data down and merges with localStorage. This means a user's preferences and saved restaurants survive device switches and browser clears.

### 19. WCAG 2.1 AA Accessibility Audit + Fixes
**Commits:** `70458db`, `fbf6314`  
Autonomous pipeline ran an accessibility audit against the CSS and component tree. Fixes: minimum touch target sizes enforced (48px height on all interactive elements), color contrast ratios verified, `aria-live` regions added to all dynamic status areas, `aria-pressed` on toggle buttons, `aria-label` on all icon/mic buttons, hidden `sr-announce` div in `App.tsx` for screen-reader announcements.

### 20. V3 Marketing Website
**Commits:** `c7184d8`, `ccbe986`, `68226c1`, `590247b`  
Standalone `website/index.html` (single inlined file — no build step, deploys as a static asset). Sections: hero, problem/solution, how it works, demo animation, call to action. The demo section auto-plays a CSS animation showing the voice loop. The site is served at `/website/` and linked from the app. All CSS/JS is inline so Vercel serves it correctly without a bundler.

---

## Key Lessons Learned

### iOS Audio Is a Minefield
- **AudioContext must be created inside a user gesture.** Any `AudioContext` made outside a gesture is created in `suspended` state and `.resume()` silently fails on iOS Safari. The workaround: one shared `AudioContext` created on the first tap, stored globally, reused by all earcons.
- **SpeechSynthesis utterances get GC'd on iOS Safari** mid-speech, causing `onend` to never fire and the app to hang waiting for TTS. Fix: hold a reference on `window._mvUtterance`.
- **`<audio>.play()` from a timer is blocked.** Even if you've played audio before, a new `Audio(blobUrl)` created from a `fetch()` callback needs the "priming" trick (play+pause a muted element from inside a gesture) to be allowed.
- **Web Audio VAD is unreliable on iOS.** Echo cancellation zeroes out the analyser's RMS, so silence detection never fires. The only reliable solution is the native OS speech recognizer via `webkitSpeechRecognition`.

### Web Speech API vs MediaRecorder + Whisper
- Web Speech API is free, instant, and handles silence detection natively. Use it for the main conversation loop.
- MediaRecorder + Whisper is more accurate (especially for short commands and non-standard speech) but costs money per request and has ~1–2s round-trip latency. Keep it for secondary inputs (speaking a name, speaking a dislike) where accuracy matters more than speed.
- iOS sometimes fires `onend` before sending `isFinal: true`. The `SpeechManager` handles this by treating any non-empty transcript as final if the recognition session ends.

### Turn-Taking Is the Core UX Invariant
The app must never listen while it is speaking. Violating this causes the TTS audio to loop back through the mic and get transcribed as the user's words. Every `startMic()` call is gated behind `await speak(...)` completing. The `isSpeaking()` flag on the speech module is the single source of truth.

### Serverless CORS Proxy Is Non-Negotiable
Every restaurant website blocks direct `fetch()` from the browser with CORS headers. Even if they didn't, the browser's own security policy blocks many cross-origin responses. The `/api/scrape` proxy is the only reliable way to fetch arbitrary restaurant websites.

### Storage Quota Is Real
localStorage has a 5–10 MB limit. A single parsed menu with many items can be 50–100 KB. After ~50–100 saved restaurants the quota fills. The `trySetItem()` function silently drops the oldest entries rather than crashing.

### Auto-Capture Audio + Visual Coaching Must Be Sequenced
Running the OpenAI TTS intro and the `coach()` (browser voice) guidance simultaneously creates two voices talking at once. The fix: `await speak(intro)` fully completes before `autoRef.current.start()` is called. The `coach()` guard (`if (_speaking) return`) then prevents any overlap during later coaching cues.

### Accessibility-First Pays Off for All Users
Every `aria-live="polite"` region, `aria-label`, and minimum touch target that was added for VoiceOver compatibility also improves the experience for sighted users on small screens. The WCAG audit fixed real usability issues (tiny tap targets, low-contrast status text) that affected everyone.

### Vercel Deployment Gotchas
- **Runtime spec:** `vercel.json` must specify `"runtime": "nodejs20.x"` for TypeScript API routes. An invalid runtime string causes silent deploy failures.
- **`Buffer` type:** Vercel serverless TypeScript needs `import { Buffer } from 'buffer'` explicitly — it's not globally available like in Node.
- **CORS origin:** The OAuth whitelist (if any) must match the exact production URL including protocol and subdomain.
- **Env var naming:** Server-side functions use `process.env.OPENAI_API_KEY`. `VITE_OPENAI_API_KEY` is only for localhost development and should not be set in hosted environments.
- **Static HTML file:** Inline all CSS and JS into a single `.html` file if you want Vercel to serve it without a build step. External file references fail because Vercel doesn't serve relative paths from the same directory by default for static assets in `public/`.

### Model Choices
- Vision/menu extraction: `gpt-5.4-mini` (fast, cheap, accurate enough for structured extraction)
- Chat/conversation: `gpt-5.4-mini` (1–3 sentence replies, 220 token limit, fast)
- TTS: `tts-1-hd` with `shimmer` as default (warmest voice for accessibility context)
- Transcription: `whisper-1` (only used for secondary voice inputs in Settings/Capture)

---

## Architecture Summary (Current)

```
src/
  App.tsx              — navigation stack, profile guard
  nav.ts               — Route union type, Navigate callback type
  types.ts             — ParsedMenu, UserProfile, ChatTurn, SavedRestaurant
  state/
    ProfileContext.tsx  — profile + update/reset, localStorage persistence
  lib/
    openai.ts           — all AI calls; dual direct/proxy routing
    speech.ts           — TTS (OpenAI + browser fallback), isSpeaking(), coach()
    speechRecognition.ts — SpeechManager (Web Speech API wrapper for conversation)
    recorder.ts         — MediaRecorder wrapper (for Settings/Capture secondary mic)
    vad.ts              — silence detection via Web Audio RMS (Settings/Capture)
    earcon.ts           — Web Audio earcons (no files, zero latency)
    audioUnlock.ts      — iOS audio gate unlock, shared AudioContext
    camera.ts           — getUserMedia, captureFrame, compressImage, torch
    autocapture.ts      — auto-shutter: brightness + content + steadiness loop
    storage.ts          — localStorage + cloud sync (/api/sync)
  hooks/
    useVoiceNav.ts      — reusable voice command hook (record → transcribe → dispatch)
  screens/
    LoginScreen         — email entry + cloud restore
    OnboardingScreen    — voice-guided first-run setup
    HomeScreen          — main menu: Scan, URL, Saved, Settings
    CaptureScreen       — camera + auto-capture + voice commands
    UrlScreen           — menu from website URL
    ConversationScreen  — core voice conversation loop (Web Speech API)
    BrowseScreen        — silent semantic menu (VoiceOver heading rotor)
    SavedScreen         — saved restaurant list
    SettingsScreen      — full voice-controlled settings
api/
  chat.ts              — /api/chat → OpenAI chat completions
  tts.ts               — /api/tts → OpenAI speech synthesis
  transcribe.ts        — /api/transcribe → Whisper
  scrape.ts            — /api/scrape → fetch + parse restaurant website
  sync.ts              — /api/sync → Vercel KV cloud profile/restaurant sync
website/
  index.html           — standalone marketing site (inlined CSS/JS)
```
