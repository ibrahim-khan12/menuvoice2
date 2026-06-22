# MenuVoice Analytics — Database Setup & Query Guide

## What gets recorded

Every meaningful action in a session writes a row to the `events` table:

| When it happens | event_type | event_name |
|---|---|---|
| App opens / closes | session | start, end |
| Login / logout | auth | login, logout |
| Screen change | nav | screen_enter, screen_exit |
| Camera starts or fails | capture | camera_start |
| Photo taken (auto or manual) | capture | photo_added |
| Photo uploaded from library | capture | file_upload |
| Analyze tapped | capture | analyze_start |
| OCR finishes (pass or fail) | capture | ocr_result |
| URL menu scraped | menu | parse_url |
| User speaks a question | ask | user_utterance |
| LLM request sent | ask | llm_request |
| First token arrives | ask | llm_first_token |
| Full reply received | ask | llm_reply |
| User says "exit" / "bye" | ask | exit_phrase |
| User says "repeat that" | ask | repeat_phrase |
| LLM error (401, 429, timeout) | ask | error |
| Each conversation turn | message | turn |
| TTS starts / ends | speech | tts_start, tts_end |
| OpenAI TTS fails → browser | speech | tts_fallback |
| User says "stop" mid-speech | speech | bargein |
| Auto-capture coaching fires | speech | coach |
| STT mic denied | speech | stt_error |
| Session learnings extracted | learnings | extracted |
| Restaurant saved | restaurant | saved |
| Restaurant deleted | restaurant | deleted |
| Profile field changed | profile | update |
| Cloud sync push / pull | sync | push, pull |
| Storage quota exceeded | error | storage_quota |
| Camera permission denied | error | camera |
| Scanner guidance state change | capture | guidance |
| Scanner gives up → manual mode | capture | scanner_struggle |
| Find-by-name search submitted | find | search_start |
| Find-by-name result (pass/fail) | menu | find_by_name |
| Website URL submitted | url | submit |
| Saved restaurant opened | saved | open |
| Saved restaurant deleted | saved | delete |
| Voice/browse mode toggled | conversation | mode_toggle |

Every row also carries: `user_email`, `session_id`, `screen`, `client_ts`, `outcome` (success/failure), `duration_ms`, `app_version`, `user_agent`.

---

## Provisioning (one-time, ~5 minutes)

### 1. Vercel Postgres (event storage)

1. Vercel dashboard → **Storage** → **Create Database** → **Postgres (Neon)**
2. Name it (e.g. `menuvoice-events`), pick the nearest region, click Create
3. **Connect to Project** → select menuvoice2

Vercel injects `POSTGRES_URL` automatically. The `events` table is created on the first request to `/api/events` — no manual migration needed.

### 2. Vercel Blob (menu photo storage)

Only needed if you want to save captured menu photos for review.

1. Storage → **Create Database** → **Blob**
2. Name it, connect to project

Vercel injects `BLOB_READ_WRITE_TOKEN` automatically.

To enable photo saving: open the app → Settings → turn on **"Save menu photos for analysis"**. Default is OFF.

### 3. Local dev

```
vercel dev
```

Pulls all linked env vars and runs `api/*.ts` locally. The table is created on first use.

---

## Browsing data

### Live dashboard (`/api/dashboard`) — the visual command center

The richest view: **what is everyone doing, updating itself.** Open it once and leave
it up — it re-fetches every 30 seconds and re-renders in place (no reload), pausing
while the tab is hidden.

```
https://<deployment>/api/dashboard?key=<REPORT_KEY>
```

What it shows:
- **KPI cards with trend deltas** — events, sessions, signed-in users, anon sessions,
  failures, each compared against the *previous equal window* (▲/▼ %), so you see change.
- **Activity-over-time chart** — events per hour (or per day for windows > 72h), with
  failures highlighted in red and quiet gaps visible at a glance.
- **Usage funnel** — camera → photo → analyze → menu read → asked → answered, with the
  step-to-step conversion %, so you see where people drop off.
- **Top screens** and **top events** (count, failures, avg latency).
- **People** — per-user table: sessions, events, photos, questions, failures, lifetime
  sessions, last-seen, and a NEW badge for first-time users.
- **Live event stream** and a **failures** panel, both auto-updating.
- Window switcher (1h / 6h / 24h / 7d / 30d / all) with no reload.

Same `REPORT_KEY` guard, same `events` table, zero AI tokens. `?format=json` returns the
same numbers as raw JSON (this is what the page polls). Validate the SQL locally with
`node scripts/test-dashboard.mjs [hours]`.

Use `/api/morning` for the daily "who's new" email digest, `/api/report` for static
table dumps, and `/api/dashboard` for the always-on visual view.

### Morning report (`/api/morning`)

A focused daily digest answering: **did anyone use MenuVoice, who is new, who came back.**

```
https://<deployment>/api/morning?key=<REPORT_KEY>
```

- **New users** = first-ever event landed inside the window.
- **Returning ("original") users** = used it before, came back — shown with lifetime session count + "what they did" (menus scanned, questions asked, searches, saves).
- **Identified users only.** The report counts people by `user_email`. A session's
  pre-login rows (session start / first screen / welcome TTS, fired before Google
  login attaches the email) are NOT counted as a separate "anonymous" user — they
  belong to whichever account the session resolves to. There is no anonymous metric.
- **Internal/test accounts are excluded** via `REPORT_EXCLUDE_EMAILS` when configured.
  Use comma-separated addresses, for example `internal@example.com,qa@example.com`.
- Window: `?hours=N` or `?days=N` (default 24h). Output: HTML (default), `?format=text` (cron/email friendly), or `?format=json`.
- Same `REPORT_KEY` guard. Zero AI tokens.

#### Automated daily email (`/api/cron-morning`)

A Vercel Cron (configured in `vercel.json`, runs `0 11 * * *` = 11:00 UTC =
**7:00 AM Eastern during EDT**; it is 6 AM ET during winter/EST) calls
`/api/cron-morning`, builds the digest, and emails it to `REPORT_EMAIL_TO`.
Use an inbox filter on subject `[MenuVoice] Morning report` if you want reports
auto-labeled.

Required env vars in Vercel (Project → Settings → Env Vars), then redeploy:
- `REPORT_KEY` — already set (guards the manual trigger).
- **One** email transport:
  - `RESEND_API_KEY` (+ optional `RESEND_FROM`), **or**
  - `GMAIL_USER` + `GMAIL_APP_PASSWORD` (Gmail account + an App Password; requires 2FA).
- Required when server email transport is configured: `REPORT_EMAIL_TO`. Use comma-separated
  recipients, for example `reports@example.com,ops@example.com`.
- Optional: `REPORT_EMAIL_HOURS` (default 24), `REPORT_EXCLUDE_EMAILS`.

Notes: Vercel Cron only fires on **production** deployments. To test delivery on demand,
hit `https://<deployment>/api/cron-morning?key=<REPORT_KEY>`. Validate the SQL locally with
`node scripts/test-morning.mjs [hours]`.

### Vercel dashboard (quickest)

Storage → your Postgres db → **Query** tab — full SQL editor, live data.

### Any Postgres client (TablePlus, DBeaver, psql)

Storage → your db → **Connect** tab → copy the connection string:
```
postgresql://user:password@host/dbname?sslmode=require
```

---

## Useful queries

```sql
-- Everything in the last hour
SELECT ts, user_email, screen, event_type, event_name, outcome, duration_ms
FROM events
ORDER BY ts DESC
LIMIT 200;

-- All event types and counts
SELECT event_type, event_name, count(*), round(avg(duration_ms)) avg_ms
FROM events
GROUP BY 1, 2
ORDER BY 3 DESC;

-- All events for one user
SELECT ts, screen, event_type, event_name, outcome, duration_ms
FROM events
WHERE user_email = 'user@example.com'
ORDER BY ts DESC;

-- Full conversation transcript for one session
SELECT client_ts, event_name,
       content->>'role'  AS role,
       content->>'text'  AS text
FROM events
WHERE session_id = 'paste-session-id-here'
  AND event_type IN ('ask', 'message')
ORDER BY client_ts;

-- OCR failures (what went wrong and for whom)
SELECT ts, user_email, metadata->>'error' AS error
FROM events
WHERE event_name = 'ocr_result'
  AND outcome = 'failure'
ORDER BY ts DESC;

-- Average assistant reply latency per user
SELECT user_email,
       round(avg(duration_ms)) AS avg_ms,
       count(*)                AS replies
FROM events
WHERE event_name = 'llm_reply'
GROUP BY user_email
ORDER BY 2 DESC;

-- Time-to-first-token by day
SELECT date_trunc('day', ts)   AS day,
       round(avg(duration_ms)) AS avg_ms,
       count(*)                AS calls
FROM events
WHERE event_name = 'llm_first_token'
GROUP BY 1
ORDER BY 1 DESC;

-- Sessions that had turns but never finished (abandonment)
SELECT session_id,
       min(ts)        AS started,
       max(ts)        AS last_event,
       count(*)       AS turn_count
FROM events
WHERE event_name = 'turn'
  AND session_id NOT IN (
    SELECT DISTINCT session_id FROM events WHERE event_name = 'extracted'
  )
GROUP BY session_id
ORDER BY started DESC;

-- Users who hit the browser TTS fallback (OpenAI TTS failing for them)
SELECT user_email,
       count(*) AS fallbacks,
       max(ts)  AS last_occurrence
FROM events
WHERE event_name = 'tts_fallback'
GROUP BY user_email
ORDER BY 2 DESC;

-- Barge-in frequency per user (how often they interrupt the app)
SELECT user_email, count(*) AS bargeins
FROM events
WHERE event_name = 'bargein'
GROUP BY user_email
ORDER BY 2 DESC;

-- What users are ordering (learnings extracted)
SELECT user_email,
       ts,
       content->'orders'       AS orders,
       content->'cuisines_liked' AS cuisines,
       content->'dislikes'     AS dislikes
FROM events
WHERE event_name = 'extracted'
ORDER BY ts DESC;

-- Menu photos for a specific session (requires image logging ON)
SELECT ts, user_email,
       jsonb_array_elements_text(content->'blobUrls') AS image_url
FROM events
WHERE event_name = 'ocr_result'
  AND content ? 'blobUrls'
ORDER BY ts DESC;
```

---

## Reading JSONB fields

`content` and `metadata` are JSONB. Use:
- `column->>'key'` → text value
- `column->'key'` → JSON sub-object
- `column ? 'key'` → true if key exists
- `jsonb_array_elements_text(column->'key')` → expand a JSON array into rows

---

## What "success" and "failure" mean per event

| event_name | outcome='success' | outcome='failure' |
|---|---|---|
| ocr_result | menu items found | parse error or zero items |
| llm_reply | full reply received | — (tracked as ask.error instead) |
| ask.error | — | 401 / 429 / timeout from OpenAI |
| camera_start | camera stream opened | permission denied or unavailable |
| parse_url | menu items scraped | scrape failed or zero items |
| tts_end | audio finished | — |
| tts_fallback | — | OpenAI TTS failed → fell back to browser |
| sync push/pull | fetch succeeded | network error |
