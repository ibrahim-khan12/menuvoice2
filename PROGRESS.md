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

LEFT OFF: all five improvements shipped, deployed, and smoke-tested in
production (https://menuvoice-sigma.vercel.app). Next session: real-device test
of the new scanner in restaurant lighting, then tune scanner.ts thresholds; check
whether BROWSERLESS_TOKEN needs renewing for JS-heavy menu sites.
