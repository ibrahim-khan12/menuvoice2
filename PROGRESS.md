# PROGRESS — running worklog

Companion to PLAN.md. Newest entries at the bottom. If a session ends mid-task,
the "LEFT OFF" line at the bottom says exactly where.

## 2026-06-11

- [x] Scanned full menuvoice2 codebase + menuvoice 3 experiment.
- [x] Confirmed OpenAI Responses API `web_search` tool shape (`tools: [{type:"web_search"}]`).
- [x] Wrote PLAN.md with the five improvements.
- [x] 1. New guided scanner `src/lib/scanner.ts` (glare + blur + coverage + directional
      hints + best-shot fallback); deleted `autocapture.ts`; CaptureScreen wired;
      guidance states tracked to DB.
- [x] 2. Server menu pipeline: `api/_menuCore.ts` (fetch/classify HTML|PDF|image,
      JS-shell Browserless fallback, one menu-link hop, OpenAI extraction with PDF
      file input), `api/menu-from-url.ts`, `api/find-menu.ts` (web_search two-stage).
      vercel.json maxDuration 60 for both.
- [x] 3. `FindScreen` (find menu by restaurant NAME), Home redesigned
      (Find a Restaurant / Scan a Menu / Saved / Website Link), UrlScreen now one
      server call + PDF-capable copy, `find` route added.
- [x] 4. MenuDocument heading hierarchy: h1 restaurant → h2 category (+item count)
      → h3 dish (name + price, one rotor stop) → h4 Description / Ingredients.
      `.browse-item-sub` CSS added.
- [x] 5. Telemetry: added saved open/delete, url submit, find search, scanner
      guidance, conversation mode_toggle. find/parse tracked in openai.ts.

### Verification results (all live, 2026-06-11 late evening)
- `scripts/test-db.mjs`: schema ✔, insert ✔, read-back ✔, cleanup ✔.
- End-to-end: POST to PRODUCTION /api/events → row visible in Postgres → cleaned up. ✔
- `scripts/test-find-menu.mjs`: gpt-5.4-mini + web_search found McAlister's Deli,
  menu URL + 10 items in 6s. ✔ (Stage-2 URL fetch matters: search snippets often
  lack prices.)
- Production /api/chat health check: 200, real completion. Server OPENAI_API_KEY
  in production is VALID.
- **Note:** `OPENAI_API_KEY` in local `.env.local` is STALE/revoked (401). Re-run
  `vercel env pull` before local server testing. Production unaffected.
- `npm run build` green; api/*.ts type-check clean.

### Production smoke tests (after deploy, 2026-06-11 ~23:35)
- Hit ERR_MODULE_NOT_FOUND on first deploy: ESM runtime needs explicit `.js`
  extension on the `./_menuCore` import. Fixed in 6a2c4e9. Lesson recorded.
- POST /api/find-menu {"query":"Chipotle Mexican Grill"} → 200 in 11s, full menu
  with descriptions + ingredients, via stage-1 web search. ✔
- POST /api/menu-from-url with Chipotle's PDF menu → 200 in 13s, structured menu
  parsed from the PDF (proves fetchMenuSource + parseMenuSource, the same code
  stage 2 uses). ✔
- JS-shell pages (e.g. mcalistersdeli.com/menu) return the friendly 422 fast —
  Browserless fallback appears inactive (token may be exhausted). Find-by-name
  covers those restaurants via web search instead.

### Known follow-ups (not blocking the prototype)
- `api/scrape.ts` is now unused by the client (replaced by menu-from-url). Kept
  for backward compat; delete once confirmed nothing else calls it.
- Events table was almost empty before today — production telemetry only started
  landing recently; watch counts after next real session.
- Scanner thresholds (LUM_DARK, SHARP_MIN, EDGE_MIN in scanner.ts) tuned on
  theory; adjust after a real-device test in restaurant lighting.

## 2026-06-12

### Incomplete-menu honesty + supplement flow (user-requested)
- [x] `ParsedMenu.incomplete?: boolean` added (src/types.ts + api/_menuCore.ts).
      Every parse path now asks the model to judge completeness: photo OCR
      (openai.ts), URL/PDF pipeline (_menuCore.ts PARSE_INSTRUCTIONS), and
      find-by-name web search (find-menu.ts FIND_JSON_SHAPE).
- [x] Opening speech: when incomplete, says EXACTLY "This wasn't a complete
      menu." FIRST, one sentence, then the normal section overview
      (buildOpeningLine).
- [x] Results page: banner at the very top — the same one sentence plus an
      "Add menu photos" button.
- [x] Add-photos flow: capture route takes `appendTo`; CaptureScreen merges the
      new parse into the existing menu (mergeMenus: items join matching
      categories by name, dedupe by item name; incomplete flag re-judged from
      the new photos).
- [x] Chat system prompt warns the assistant the menu is partial so it doesn't
      overclaim and suggests adding photos.

### VoiceOver P0/P1 fixes (from VOICEOVER-AUDIT.md)
- [x] ConversationScreen phase indicator: aria-live OFF while recording so
      VoiceOver isn't transcribed by the open mic (P0 #2).
- [x] FindScreen + CaptureScreen reassurance phrases now also land in the
      role="status" region, not TTS-only (P0 #3).
- [x] Heading order fixed: page h1 = restaurant, menu section starts at
      h2 "Full menu" → h2 categories → h3 dishes → h4 details; restaurant no
      longer appears twice in the rotor (P1).

### Sub-agent reports (in repo root)
- VOICEOVER-AUDIT.md — 3 P0 / 9 P1 / 10 P2 findings with code fixes.
  REMAINING P0 #1: app TTS talks over VoiceOver on screen entry; needs a
  profile-level app-voice toggle gating speak() in speech.ts.
- IDEAS.md — prioritized feature backlog (top: allergen flags in browse view,
  voice input for FindScreen, waiter card, GPS-assisted find).
- SMOKE-RESULTS.md + scripts/smoke-restaurants.mjs — production endpoint test
  matrix (agent may still be writing).
- REVIEW.md — code review of the last 3 commits (agent may still be writing).

### Tier 1 fixes from REVIEW.md (2026-06-12, second session, commit f0f725d)
- [x] SSRF guard (REVIEW.md CRITICAL): api/_menuCore.ts assertPublicUrl()
      rejects non-http(s) schemes and localhost/private/link-local/metadata
      hosts before fetchOne(), and re-checks response.url after redirects.
- [x] FindScreen re-entrancy (REVIEW.md major): inFlightRef guard stops
      parallel find() calls / orphaned reassurance intervals.
- [x] Telemetry batch wedging (REVIEW.md major): flush() caps body at 60 KB
      (keepalive/sendBeacon reject >64 KiB); oversized batches split in half
      back onto the queue, a single never-sendable poison event is dropped.
- [in progress] VOICEOVER-AUDIT P0 #1 global app-voice toggle: sub-agent
      adding appVoice to profile, gating speak()/coach() in src/lib/speech.ts,
      Settings toggle. If not committed, check git status for its edits.

LEFT OFF (2026-06-12 second session): three REVIEW.md Tier-1 fixes committed
(f0f725d) and build green. Sub-agent was finishing the app-voice toggle at the
4:41 PM hard stop — verify speech.ts/SettingsScreen.tsx edits, run npm run
build, commit, push. Then: REVIEW.md remaining majors (LLM category validation
in find-menu.ts, iOS coach utterance drop in speech.ts), SMOKE-RESULTS.md
chain-restaurant 404s (check BROWSERLESS_TOKEN), VOICEOVER-AUDIT P1s, push to
deploy.
