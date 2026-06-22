# Code Review — commits 801f7e4, 6a2c4e9, ba44557

Scope: src/lib/scanner.ts, api/_menuCore.ts, api/find-menu.ts, api/menu-from-url.ts,
src/screens/FindScreen.tsx, src/lib/telemetry.ts, api/events.ts.
API files and openai.ts reviewed at HEAD (working tree is being edited by someone else).
Line numbers for api/_menuCore.ts, api/find-menu.ts, api/menu-from-url.ts refer to `git show HEAD:<path>`.

---

## Critical

### 1. SSRF — server fetches user/model-supplied URLs with no private-network protection
> **✅ FIXED** — `assertPublicUrl()` added to `api/_menuCore.ts`; re-validated after every redirect hop.

**api/_menuCore.ts:110-118 (`fetchOne`), reachable from api/menu-from-url.ts:13-23 and api/find-menu.ts:116-117**

`fetchOne()` fetches any URL with `redirect: 'follow'` and no hostname/IP checks. `menu-from-url`
validates only the protocol; `find-menu` stage 2 fetches `result.menuUrl` straight out of the
LLM's web-search output (steerable via prompt injection in the user query or in pages the model
reads — the query is interpolated unescaped into the prompt at find-menu.ts:28-30). On Vercel an
attacker can probe internal/loopback services, other functions, or cloud metadata endpoints
(`http://169.254.169.254/...`, `http://localhost:port`, decimal/hex IP encodings, hostnames that
resolve to private IPs, or a public URL that 302-redirects to a private one). `findMenuLinks` then
follows links found in the attacker's HTML, giving a second SSRF hop. Response bodies are returned
to the caller via the parsed menu, so this is full read SSRF, not blind.

**Fix (in `fetchOne`, applied to the original URL, every redirect hop, and every link hop):**
```ts
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const PRIVATE = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^f[cd]/i, /^::ffff:/i,
];
async function assertPublicHost(u: URL) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new FriendlyError('Unsupported URL.', 400);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal'))
    throw new FriendlyError('That address is not reachable.', 400);
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs)
    if (PRIVATE.some((re) => re.test(a.address)))
      throw new FriendlyError('That address is not reachable.', 400);
}
// in fetchOne: await assertPublicHost(new URL(url));
// use redirect: 'manual' and re-validate each Location before following (max ~5 hops),
// since redirect: 'follow' bypasses the pre-flight DNS check.
```
(DNS-rebinding-proof solutions pin the resolved IP via a custom agent; the above blocks the
practical cases. Also validate `result.menuUrl` with the same check before stage 2.)

---

## Major

### 2. find-menu returns unvalidated LLM `categories` — malformed shape crashes the client mid-flow
> **OPEN** — tracked as C2 in FIXES-NEEDED.md.

**api/find-menu.ts:100-110; consumed by src/lib/openai.ts (HEAD) `findMenuByName` and `buildOpeningLine`**

Stage 1 forwards `result.categories` verbatim if `menuItemCount(direct) >= 3`. `menuItemCount`
tolerates a category without `items` (`c.items?.length ?? 0`), but the client does not:
`findMenuByName` computes `data.menu.categories.reduce((s, c) => s + c.items.length, 0)` and
`buildOpeningLine` does the same. One model-emitted category missing `items` (or `items` as a
string) throws `TypeError: undefined is not an object` — which FindScreen then *speaks aloud* to a
blind user as the error message. Item fields (name/price) are also unvalidated.

**Fix (find-menu.ts, before building `direct`):**
```ts
const categories = (Array.isArray(result?.categories) ? result.categories : [])
  .filter((c: any) => c && typeof c.name === 'string' && Array.isArray(c.items))
  .map((c: any) => ({
    name: c.name,
    items: c.items.filter((it: any) => it && typeof it.name === 'string'),
  }));
```

### 3. Telemetry flush can wedge permanently: 64 KB `keepalive` limit + head-of-line blocking + unbounded queue
> **✅ FIXED** — 60 KB cap, split or drop poison event, re-entrancy guard added.

**src/lib/telemetry.ts:88-107 (`flush`), 70-85 (`track`)**

`fetch(..., { keepalive: true })` rejects when the body exceeds 64 KiB (spec'd limit, enforced by
Chrome and Safari). A batch is up to 50 events, and events carry full content payloads
(`llm_reply` text, queries, coach strings, user_agent on every row) — 50 events easily exceeds
64 KiB. When that happens flush throws, the batch is `unshift`ed back, and the *same* oversized
batch is retried forever: telemetry never sends again, `_queue` grows without bound, and
`persist()` re-serializes the entire queue to localStorage on every `track()` call (O(n) JSON
stringify on the main thread, then silent quota failure). Same head-of-line block if a single
poison event causes a non-OK response.

**Fix:**
```ts
const MAX_QUEUE = 500;            // drop oldest beyond this in track()
const MAX_BODY = 60_000;
async function flush(beacon = false) {
  if (!_queue.length) return;
  let n = Math.min(_queue.length, MAX_BATCH);
  let body = JSON.stringify({ events: _queue.slice(0, n) });
  while (body.length > MAX_BODY && n > 1) { n = Math.ceil(n / 2); body = JSON.stringify({ events: _queue.slice(0, n) }); }
  if (body.length > MAX_BODY && n === 1) { _queue.shift(); persist(); return; } // drop poison event
  const batch = _queue.splice(0, n); persist();
  ...
}
```
Also add a re-entrancy guard (`let flushing = false`) so the 10 s interval doesn't overlap a slow
in-flight flush, and don't use `keepalive` on the non-beacon path at all (it's only needed at
pagehide, where `sendBeacon` is already used).

### 4. FindScreen: stale `loading` closure can leak the reassurance interval — speaks "Still searching…" forever over the menu conversation
> **✅ FIXED** — `inFlightRef` guard prevents parallel `find()` calls; interval cleanup in `finally` block.

**src/screens/FindScreen.tsx:53-56, 84, with no in-flight guard in `find` (39-69)**

`find()` has no synchronous re-entry guard; the Enter handler checks the `loading` value captured
at render time, so Enter pressed twice before React re-renders (or Enter + button tap) runs
`find()` twice. The second call overwrites `reassureRef.current`, orphaning the first interval.
Cleanup and the success/error paths clear only the ref'd interval, so the orphan keeps firing
`speak('Still searching…')` every 9 s for the rest of the session — including after navigating to
the conversation screen, where each firing calls `stopSpeaking()` and cuts off the menu being read
to the user. For a voice-first app this is session-breaking.

**Fix:**
```ts
const find = async () => {
  if (loadingRef.current) return;          // const loadingRef = useRef(false)
  loadingRef.current = true;
  ...
  if (reassureRef.current) clearInterval(reassureRef.current); // before re-assigning
  reassureRef.current = setInterval(...);
  try { ... } finally {
    if (reassureRef.current) { clearInterval(reassureRef.current); reassureRef.current = null; }
    loadingRef.current = false;
  }
};
```

### 5. api/events.ts: unauthenticated, CORS `*`, no rate limit — anyone can write unlimited rows (and arbitrary `user_email`) to paid Postgres
> **✅ FIXED** — CORS hardened, per-field size caps applied, row cap 50, `Promise.allSettled`.

**api/events.ts:63-67, 78-83**

The endpoint is wide open cross-origin, accepts 100 rows per call with no per-field size caps
(content/metadata JSONB and user_agent can each be megabytes up to Vercel's body limit), and
trusts client-supplied `user_email` — so a third party can flood the events table (storage +
compute cost on Vercel Postgres) or poison analytics attributed to real users.

**Fix:** drop the `Access-Control-Allow-Origin: *` header (the app calls same-origin `/api/events`;
sendBeacon same-origin needs no CORS), require a shared header token or at least check
`req.headers.origin`/`referer` against the deployment host, and clamp sizes:
```ts
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
// session_id/event_type/event_name: s(...,128); user_agent: s(...,512);
// contentStr/metaStr: reject or truncate if > 8_000 chars; rows.slice(0, 50)
```

### 6. iOS Safari: `coach()` calls `speechSynthesis.cancel()` then `speak()` synchronously — utterances are frequently dropped
> **OPEN** — tracked as C4 in FIXES-NEEDED.md (HIGH RISK, core accessibility loop goes silent on iOS).

**src/lib/speech.ts (HEAD) `coach()`; primary consumer is the scanner coaching path (src/lib/scanner.ts emit → CaptureScreen onCoach)**

On iOS WebKit, `speechSynthesis.speak()` issued in the same task as `cancel()` is silently
swallowed (long-standing WebKit behavior). `coach()` does exactly this, so on the target platform
the guided scanner's coaching, countdown ("Hold still. Three. Two. One.") and "Got it, photo 1"
confirmations randomly never play — the core accessibility loop goes silent.

**Fix:**
```ts
window.speechSynthesis.cancel();
setTimeout(() => {                 // give WebKit a task boundary after cancel()
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}, 60);
```
(Also queue rather than cancel when the previous coach utterance is the countdown, so ticks aren't
self-cancelling at the 170 ms tick rate.)

### 7. find-menu worst-case runtime far exceeds its 60 s `maxDuration` — opaque 504 instead of the friendly error
> **✅ FIXED** — 35s search budget, 55s total deadline, friendly timeout error added.

**api/find-menu.ts:73 (50 s search) + 117-118 (fetchMenuSource: 15 s + 25 s Browserless + up to 2 link hops) + parse (55 s); vercel.json `api/find-menu.ts: 60`**

The internal timeouts sum to several minutes, but Vercel kills the function at 60 s. Any search
taking ~50 s leaves no budget for stage 2, so the user hears a generic network failure rather than
the carefully written "menu not online" message. Same risk in menu-from-url (15+25+2×40+55 s vs 60 s).

**Fix:** budget the stages, e.g. `AbortSignal.timeout(30000)` for the search, skip Browserless in
stage 2 (or cap `fetchMenuSource` with an overall deadline passed down), and keep total < ~55 s:
```ts
const deadline = Date.now() + 55_000;
const remaining = () => Math.max(1_000, deadline - Date.now());
// signal: AbortSignal.timeout(Math.min(15000, remaining())) at each hop
```

---

## Minor

### 8. PDF size checked only after the whole body is buffered; no Content-Length pre-check
> **OPEN** — tracked as C5 in FIXES-NEEDED.md.

**api/_menuCore.ts:134-139**

`await response.arrayBuffer()` downloads an unbounded body into serverless memory before the
15 MB check; a hostile or chunked endless stream can OOM the function (also applies to the HTML
branch — `response.text()` is unbounded, sliced to 60 k only afterwards).
**Fix:** check `Number(response.headers.get('content-length') || 0) > MAX_PDF_BYTES` first, and
read via `response.body.getReader()` accumulating with an early abort once the cap is exceeded.

### 9. Scanner: struggle timer fires even mid-countdown, yanking auto mode away right before capture
> **✅ FIXED** — struggle timer now checks `goodSince` before firing.

**src/lib/scanner.ts:266-270**

The 20 s `STRUGGLE_MS` check runs before the quality pipeline and ignores progress: if the user
finally got steady at t=19.5 s (steady=3, capture 170 ms away), `onStruggle` still fires at 20 s,
CaptureScreen flips to manual, and the imminent capture is lost — demoralizing for the exact users
the feature serves.
**Fix:** `if (!this.struggled && this.steady === 0 && !this.goodSince && Date.now() - this.armedAt > STRUGGLE_MS)`
(or reset `armedAt` whenever `goodSince` is first set).

### 10. Scanner: heartbeat re-nags every 6 s, contradicting the documented "silence after second message"
> **✅ FIXED** — heartbeat gated to `coachStage === 1` with 3x interval, state-neutral phrase.

**src/lib/scanner.ts:180-182 (`coachFor`)**

After stage-1 escalation, the `now - lastCoachAt > HEARTBEAT_MS` branch emits "Still looking. Keep
the menu under the camera." every 6 s indefinitely, in *every* coached state (including `dark` and
`glare`, where the text is wrong). The file header promises "after the second, silence until the
state changes."
**Fix:** gate it: `else if (this.coachStage === 1 && now - this.lastCoachAt > HEARTBEAT_MS * 3)`
and use a state-neutral phrase, or drop the branch.

### 11. Scanner: `stop()` keeps references to the video element and callbacks
> **✅ FIXED** — `stop()` now nulls `this.video`, `this.cb`, `this.prev`.

**src/lib/scanner.ts:142-145**

`stop()` clears the timer but leaves `this.video`, `this.cb`, `this.prev` set, retaining the
detached `<video>`/stream and React closures for the scanner's lifetime.
**Fix:** `this.video = null; this.cb = null; this.prev = null;` in `stop()`.

### 12. events.ts: one malformed event silently drops the whole batch
> **✅ FIXED** — `Promise.allSettled`, `client_ts`/`duration_ms` coercion added.

**api/events.ts:85-105**

`client_ts` and `duration_ms` are inserted unvalidated; a non-timestamp string or float makes
Postgres reject that INSERT, `Promise.all` rejects, and the entire 100-row batch is discarded
(still returning 200). Use `Promise.allSettled`, and coerce:
`duration_ms: Number.isFinite(e.duration_ms) ? Math.round(e.duration_ms!) : null`,
`client_ts: typeof e.client_ts === 'string' && !isNaN(Date.parse(e.client_ts)) ? e.client_ts : null`.
(Parameterization itself is done correctly — no SQL injection found.)

### 13. Browserless token sent in the URL query string
> **OPEN** — tracked as C1 in FIXES-NEEDED.md.

**api/_menuCore.ts:94**

`?token=${BROWSERLESS_TOKEN}` ends up in intermediary/proxy/error logs. Browserless accepts the
token via header; prefer `headers: { Authorization: 'Bearer ...' }` or at minimum never log `res.url`.

### 14. menu-from-url: dead conditional
> **✅ FIXED** — simplified to `sourceUrl: source.url`.

**api/menu-from-url.ts:35**

`source.kind === 'html' ? source.url : source.url` — both branches identical. Intent was probably
to return the *final* (post-redirect / post-link-hop) URL in all cases, which `source.url` already
is; simplify to `sourceUrl: source.url`.

### 15. FindScreen: navigation tagged `source: 'url'` and `loading` left true on error focus loss
> **PARTIAL** — `autoFocus` (VoiceOver focus skips screen title) tracked as B5/P2-7 in FIXES-NEEDED.md. Analytics `source: 'url'` tag for find-by-name results still open (minor).

**src/screens/FindScreen.tsx:63**

Find-by-name results are tracked downstream as `source: 'url'`, muddying the new find-flow
analytics (nav.ts only allows `'url'`). Add `'find'` to the `Route` union and pass it.
Also `autoFocus` (line 88) moves VoiceOver focus past the screen title on entry, so the context
sentence ("Find a restaurant…") is skipped by VO users while `speak()` talks over it.

### 16. Telemetry: multi-tab and pre-init races
> **OPEN** — tracked as C3 in FIXES-NEEDED.md.

**src/lib/telemetry.ts:113-117**

Two tabs both `restore()` the same localStorage queue and double-send it; and
`_queue = restore()` discards any events tracked before `initTelemetry()` runs. Merge instead:
`_queue = [...restore(), ..._queue]` and namespace the queue key per tab/session
(`QUEUE_KEY + ':' + sid()`), cleaning up stale session keys on init.
