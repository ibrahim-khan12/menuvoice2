// GET /api/report?key=...   ->  live, accessible HTML analytics dashboard
//
// Reads the `events` table (written by api/events.ts) and renders a self-contained
// HTML page: headline stats, per-screen/event breakdown, recent sessions, failures,
// and the latest raw events. Queries the DB on every request, so it is always current
// and costs zero AI tokens — it is plain server code, not a Claude run.
//
// Access: guarded by REPORT_KEY. Set it in Vercel (Project -> Settings -> Env Vars),
// then open  https://<deployment>/api/report?key=<REPORT_KEY>
//
// Optional query params:
//   hours=24    limit the detail tables to the last N hours (default: all time)

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@vercel/postgres';

async function withClient<T>(fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function esc(v: unknown): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMs(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtTs(ts: unknown): string {
  if (!ts) return '';
  const d = new Date(ts as string);
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z').slice(0, 19) + 'Z';
}

const DEFAULT_EXCLUDED_EMAILS = [
  'avitaldrel@gmail.com',
  'anibabug@gmail.com',
  '2firemaster27@gmail.com',
  'mibrahim.dev17@gmail.com',
  'ik8072369@gmail.com',
];

function excludeList(): string[] {
  const raw = process.env.REPORT_EXCLUDE_EMAILS ?? '';
  return Array.from(new Set([
    ...DEFAULT_EXCLUDED_EMAILS,
    ...raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  ]));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.REPORT_KEY?.trim();
  const provided = (req.query.key as string) ?? '';

  if (!expected) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(
      `<!doctype html><meta charset="utf-8"><h1>Report not configured</h1>` +
      `<p>Set a <code>REPORT_KEY</code> environment variable in Vercel, then open ` +
      `<code>/api/report?key=YOUR_KEY</code>.</p>`
    );
  }
  if (provided !== expected) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(
      `<!doctype html><meta charset="utf-8"><h1>Unauthorized</h1>` +
      `<p>Append <code>?key=YOUR_KEY</code> to the URL.</p>`
    );
  }

  const hoursRaw = Number(req.query.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 24 * 365) : null;
  const windowClause = hours ? `ts > now() - interval '${hours} hours'` : 'TRUE';
  const windowLabel = hours ? `last ${hours} h` : 'all time';
  const exclude = excludeList();
  const keep = `(user_email IS NULL OR lower(user_email) <> ALL($1::text[]))`;
  const windowAndKeep = `${windowClause} AND ${keep}`;
  const last24AndKeep = `ts > now() - interval '24 hours' AND ${keep}`;

  try {
    const data = await withClient(async (client) => {
      const [headline, last24, byScreen, sessions, failures, recent] = await Promise.all([
        client.query(`
          SELECT
            count(*)                              AS total,
            count(DISTINCT session_id)            AS sessions,
            count(DISTINCT user_email) FILTER (WHERE user_email IS NOT NULL) AS users,
            count(*) FILTER (WHERE outcome='failure') AS failures,
            min(ts) AS first_ts, max(ts) AS last_ts
          FROM events WHERE ${windowAndKeep}
        `, [exclude]),
        client.query(`
          SELECT
            count(*) AS total,
            count(DISTINCT session_id) AS sessions,
            count(*) FILTER (WHERE outcome='failure') AS failures
          FROM events WHERE ${last24AndKeep}
        `, [exclude]),
        client.query(`
          SELECT screen, event_name,
                 count(*) AS n,
                 count(*) FILTER (WHERE outcome='failure') AS failures
          FROM events WHERE ${windowAndKeep}
          GROUP BY screen, event_name
          ORDER BY n DESC
          LIMIT 60
        `, [exclude]),
        client.query(`
          SELECT session_id,
                 min(ts) AS started,
                 max(ts) AS ended,
                 EXTRACT(EPOCH FROM (max(ts) - min(ts)))::int * 1000 AS span_ms,
                 count(*) AS events,
                 count(DISTINCT screen) AS screens,
                 count(*) FILTER (WHERE outcome='failure') AS failures,
                 max(user_email) AS user_email
          FROM events WHERE ${windowAndKeep}
          GROUP BY session_id
          ORDER BY started DESC
          LIMIT 40
        `, [exclude]),
        client.query(`
          SELECT ts, screen, event_name, session_id, content
          FROM events
          WHERE outcome='failure' AND ${windowAndKeep}
          ORDER BY ts DESC
          LIMIT 40
        `, [exclude]),
        client.query(`
          SELECT ts, screen, event_type, event_name, outcome, duration_ms, session_id
          FROM events WHERE ${windowAndKeep}
          ORDER BY ts DESC
          LIMIT 60
        `, [exclude]),
      ]);
      return { headline: headline.rows[0], last24: last24.rows[0], byScreen: byScreen.rows, sessions: sessions.rows, failures: failures.rows, recent: recent.rows };
    });

    const h = data.headline;
    const l = data.last24;

    const card = (label: string, value: unknown) =>
      `<div class="card"><div class="num">${esc(value ?? 0)}</div><div class="lbl">${esc(label)}</div></div>`;

    const byScreenRows = data.byScreen.map((r) =>
      `<tr><td>${esc(r.screen)}</td><td>${esc(r.event_name)}</td><td class="r">${esc(r.n)}</td>` +
      `<td class="r ${Number(r.failures) > 0 ? 'bad' : ''}">${esc(r.failures)}</td></tr>`
    ).join('');

    const sessionRows = data.sessions.map((r) =>
      `<tr><td class="mono">${esc(r.session_id)}</td><td>${esc(fmtTs(r.started))}</td>` +
      `<td>${esc(fmtMs(r.span_ms))}</td><td class="r">${esc(r.events)}</td>` +
      `<td class="r">${esc(r.screens)}</td>` +
      `<td class="r ${Number(r.failures) > 0 ? 'bad' : ''}">${esc(r.failures)}</td>` +
      `<td>${esc(r.user_email)}</td></tr>`
    ).join('');

    const failureRows = data.failures.length
      ? data.failures.map((r) =>
          `<tr><td>${esc(fmtTs(r.ts))}</td><td>${esc(r.screen)}</td><td>${esc(r.event_name)}</td>` +
          `<td class="mono">${esc(r.session_id)}</td>` +
          `<td class="mono small">${esc(JSON.stringify(r.content)).slice(0, 140)}</td></tr>`
        ).join('')
      : `<tr><td colspan="5">No failures in this window.</td></tr>`;

    const recentRows = data.recent.map((r) =>
      `<tr><td>${esc(fmtTs(r.ts))}</td><td>${esc(r.screen)}</td><td>${esc(r.event_type)}</td>` +
      `<td>${esc(r.event_name)}</td>` +
      `<td class="${r.outcome === 'failure' ? 'bad' : r.outcome === 'success' ? 'good' : ''}">${esc(r.outcome)}</td>` +
      `<td class="r">${r.duration_ms != null ? esc(fmtMs(r.duration_ms)) : ''}</td></tr>`
    ).join('');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MenuVoice analytics (${esc(windowLabel)})</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.5rem; max-width: 1100px; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .6rem; border-bottom: 2px solid currentColor; padding-bottom: .2rem; }
  .meta { opacity: .7; font-size: .9rem; margin-bottom: 1rem; }
  .cards { display: flex; flex-wrap: wrap; gap: .75rem; }
  .card { border: 1px solid; border-radius: 10px; padding: .8rem 1rem; min-width: 110px; }
  .num { font-size: 1.8rem; font-weight: 700; }
  .lbl { font-size: .8rem; opacity: .75; text-transform: uppercase; letter-spacing: .03em; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; font-size: .9rem; }
  th, td { text-align: left; padding: .35rem .55rem; border-bottom: 1px solid rgba(128,128,128,.3); }
  th { position: sticky; top: 0; background: Canvas; }
  td.r, th.r { text-align: right; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
  .small { font-size: .75rem; opacity: .8; }
  .bad { color: #c0392b; font-weight: 600; }
  .good { color: #1e8449; }
  .nav a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>MenuVoice analytics</h1>
<p class="meta">Window: <strong>${esc(windowLabel)}</strong> &middot; generated ${esc(fmtTs(new Date().toISOString()))}
 &middot; data ${esc(fmtTs(h.first_ts))} &rarr; ${esc(fmtTs(h.last_ts))}</p>
<p class="nav">View:
  <a href="?key=${esc(provided)}">All time</a>
  <a href="?key=${esc(provided)}&hours=24">24 h</a>
  <a href="?key=${esc(provided)}&hours=6">6 h</a>
  <a href="?key=${esc(provided)}&hours=1">1 h</a>
</p>

<h2>Headline (${esc(windowLabel)})</h2>
<div class="cards">
  ${card('Events', h.total)}
  ${card('Sessions', h.sessions)}
  ${card('Users', h.users)}
  ${card('Failures', h.failures)}
</div>

<h2>Last 24 hours</h2>
<div class="cards">
  ${card('Events', l.total)}
  ${card('Sessions', l.sessions)}
  ${card('Failures', l.failures)}
</div>

<h2>Screen &amp; event breakdown</h2>
<table>
  <thead><tr><th scope="col">Screen</th><th scope="col">Event</th><th scope="col" class="r">Count</th><th scope="col" class="r">Failures</th></tr></thead>
  <tbody>${byScreenRows}</tbody>
</table>

<h2>Sessions</h2>
<table>
  <thead><tr><th scope="col">Session</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col" class="r">Events</th><th scope="col" class="r">Screens</th><th scope="col" class="r">Failures</th><th scope="col">User</th></tr></thead>
  <tbody>${sessionRows}</tbody>
</table>

<h2>Failures</h2>
<table>
  <thead><tr><th scope="col">When</th><th scope="col">Screen</th><th scope="col">Event</th><th scope="col">Session</th><th scope="col">Detail</th></tr></thead>
  <tbody>${failureRows}</tbody>
</table>

<h2>Recent events</h2>
<table>
  <thead><tr><th scope="col">When</th><th scope="col">Screen</th><th scope="col">Type</th><th scope="col">Event</th><th scope="col">Outcome</th><th scope="col" class="r">Duration</th></tr></thead>
  <tbody>${recentRows}</tbody>
</table>

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[report] error:', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(
      `<!doctype html><meta charset="utf-8"><h1>Report error</h1><pre>${esc((err as Error).message)}</pre>`
    );
  }
}
