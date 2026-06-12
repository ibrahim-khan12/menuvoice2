# MenuVoice — Prototype Completion Plan (2026-06-11)

Goal: a working, usable prototype ASAP. Five improvements, chosen after a full scan
of this codebase and the `menuvoice 3` experiment.

## The five improvements

### 1. Replace the menu scanner (merge the best of menuvoice 3)
The current `src/lib/autocapture.ts` only measures brightness, gradient ("content"),
and motion at 80x60. menuvoice 3 added real metrics: Laplacian blur detection,
glare detection, frame coverage, and a "best-shot fallback" (capture after ~2s of
good-enough frames instead of demanding perfection).

New `src/lib/scanner.ts` combines both:
- Metrics per frame (160x120, main thread, ~6fps): mean luminance (dark), fraction
  of blown-out pixels (glare — better than mean brightness for detecting it),
  Laplacian variance (blur), edge density + centroid (is the menu in frame, and
  which way to move), inter-frame motion (steadiness).
- Guidance is *actionable*, not just "too dark/too light": directional hints
  ("move the menu to the left"), concrete fixes ("rest your elbow on the table"),
  two-stage escalation per problem, then silence until the state changes.
- Spoken 3-2-1 countdown + earcons while steadying; auto-shutter.
- Balance knob the user asked for: **best-shot fallback** — if lighting and content
  are OK but perfection never arrives, capture anyway after ~5s and let the AI cope.
- After 20s with no capture: switch to manual mode with clear instructions.
- Every guidance state transition is tracked to the events DB.

`autocapture.ts` is deleted. CaptureScreen keeps its UX (multi-photo, upload,
manual shutter, torch).

### 2. Find a restaurant by NAME (no URL hunting)
The biggest usability win: the user should never have to find a menu page.
New `api/find-menu.ts` uses the OpenAI Responses API `web_search` tool: given
"Restaurant name, city" it searches the web, reads the restaurant's site /
PDF menu / aggregator listings, and returns the menu in our ParsedMenu JSON.
If the model only finds a menu URL, the server fetches and parses it directly
(HTML or PDF). If the menu genuinely isn't online, the user is told that in
plain language.

Research notes (how restaurants actually publish menus):
- Own website HTML page (often JS-rendered) — covered by scrape + Browserless.
- PDF link on their site — NEW: now parsed via OpenAI file input.
- Ordering platforms (Toast, Square, ChowNow, Clover) — JS-heavy, covered by
  web_search reading + Browserless fallback.
- Aggregators (Yelp, DoorDash, Grubhub, Google Business) — web_search can read
  these listings when the official site fails.

New `FindScreen`: one text field ("Restaurant name and city"), spoken progress
reassurance during the 15–45s search, then straight into the conversation.

### 3. Server-side menu pipeline with PDF support
`api/_menuCore.ts` (underscore = not a route): shared fetch + classify
(HTML / PDF / image) + OpenAI parse, used by both `api/menu-from-url.ts` (replaces
the client-side scrape→chat round trip; UrlScreen now makes ONE call) and
`api/find-menu.ts`. PDFs go to OpenAI as base64 file input — previously the app
flatly refused PDFs, which a large share of restaurant menus are. Homepage menus:
if a page has no items but links to /menu, /food, /dinner etc., follow one hop.

### 4. VoiceOver navigation: proper heading hierarchy
MenuDocument becomes: h1 restaurant → h2 category (with item count) → h3 dish
(name + price in one heading so one rotor stop reads both) → h4 Description /
Ingredients per dish. Home screen reorganized around the easiest entry point:
"Find restaurant by name" joins "Scan menu with camera" up top.

### 5. Telemetry completeness + database verification
- track() added to: SavedScreen (open/delete), UrlScreen, FindScreen, scanner
  guidance transitions, voice/browse mode toggle.
- Live verification: `scripts/test-db.mjs` connects with the real POSTGRES_URL,
  ensures schema, inserts a test event, reads it back, cleans up.
- `scripts/test-find-menu.mjs` verifies the OpenAI web_search call works with the
  configured key/model before the endpoint ships.

## Execution order
1. PLAN.md / PROGRESS.md (this file)
2. scanner.ts + CaptureScreen wiring
3. api/_menuCore.ts, api/menu-from-url.ts, api/find-menu.ts, vercel.json
4. FindScreen, Home, UrlScreen, nav
5. MenuDocument headings
6. telemetry additions + DB + API verification scripts (run them)
7. npm run build, fix, update PROGRESS.md, commit

Progress and where-I-left-off live in PROGRESS.md.
