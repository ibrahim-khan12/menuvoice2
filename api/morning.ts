// GET /api/morning?key=...   ->  on-demand "morning report" digest
//
// Answers three questions, reading the same `events` table as /api/report:
//   1. Did anyone use MenuVoice in the window?  (yes / no)
//   2. Who is NEW  — first-ever event landed inside the window.
//   3. Who is a returning ("original") user — used it before, came back,
//      with lifetime session count and what they did.
//
// Internal/test accounts are excluded by REPORT_EXCLUDE_EMAILS when configured.
// Costs zero AI tokens.
//
// Access: guarded by REPORT_KEY (same key as /api/report).
//   https://<deployment>/api/morning?key=<REPORT_KEY>
//
// Optional query params:
//   hours=24    window length (default 24). days= also accepted (days*24).
//   format=text plaintext digest (cron / email friendly)
//   format=json raw JSON

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildMorningReport, renderText, renderEmailHtml, esc, fmtTs, ago, activity, reportEmailRecipients, type UserRow } from './_morningData.js';

// Subject line shared with the email path so a Gmail filter matches both.
function emailSubject(d: { anyoneUsed: boolean; newUsers: unknown[]; returningUsers: unknown[]; website?: { visits: number } }): string {
  const date = new Date().toISOString().slice(0, 10);
  return d.anyoneUsed
    ? `[MenuVoice] Morning report ${date} — ${d.newUsers.length} new, ${d.returningUsers.length} returning, ${d.website?.visits ?? 0} site visits`
    : `[MenuVoice] Morning report ${date} — no users in window`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.REPORT_KEY?.trim();
  const provided = (req.query.key as string) ?? '';
  const format = (req.query.format as string) ?? 'html';

  if (!expected) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(
      `<!doctype html><meta charset="utf-8"><h1>Report not configured</h1>` +
      `<p>Set a <code>REPORT_KEY</code> environment variable in Vercel, then open ` +
      `<code>/api/morning?key=YOUR_KEY</code>.</p>`
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
  const daysRaw = Number(req.query.days);
  let hours = 24;
  if (Number.isFinite(hoursRaw) && hoursRaw > 0) hours = hoursRaw;
  else if (Number.isFinite(daysRaw) && daysRaw > 0) hours = daysRaw * 24;

  try {
    const d = await buildMorningReport(hours);
    const t = d.totals;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(d);
    }

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(renderText(d));
    }

    // Ready-to-send email payload for an external sender (e.g. a scheduled agent
    // that delivers via Gmail). Returns the exact subject/html/text the cron uses.
    if (format === 'email') {
      const host = req.headers.host;
      const dashboardUrl = host ? `https://${host}/api/morning?key=${provided}` : undefined;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        to: reportEmailRecipients(),
        subject: emailSubject(d),
        html: renderEmailHtml(d, dashboardUrl),
        text: renderText(d),
      });
    }

    // ---- HTML dashboard view ----
    const verdict = d.anyoneUsed
      ? `<p class="verdict yes">Yes — MenuVoice was used by <strong>${esc(t.users)}</strong> ${Number(t.users) === 1 ? 'person' : 'people'} (${esc(t.sessions)} session${Number(t.sessions) === 1 ? '' : 's'}).</p>`
      : `<p class="verdict no">No one used MenuVoice in this window.</p>`;

    const card = (label: string, value: unknown, cls = '') =>
      `<div class="card ${cls}"><div class="num">${esc(value ?? 0)}</div><div class="lbl">${esc(label)}</div></div>`;

    const userRow = (u: UserRow, showLifetime: boolean) =>
      `<tr>` +
      `<td>${esc(u.user_email)}</td>` +
      `<td class="r">${esc(u.sessions)}</td>` +
      (showLifetime ? `<td class="r">${esc(u.lifetime_sessions)}</td>` : ``) +
      `<td>${esc(activity(u))}</td>` +
      `<td class="r ${Number(u.failures) > 0 ? 'bad' : ''}">${esc(u.failures)}</td>` +
      (showLifetime ? `<td>${esc(ago(u.first_ts))}</td>` : `<td>${esc(fmtTs(u.first_in_window))}</td>`) +
      `<td class="small">${esc((u.screens ?? []).join(', '))}</td>` +
      `</tr>`;

    const newTable = d.newUsers.length
      ? `<table>
          <thead><tr><th scope="col">User</th><th scope="col" class="r">Sessions</th><th scope="col">What they did</th><th scope="col" class="r">Failures</th><th scope="col">First seen</th><th scope="col">Screens</th></tr></thead>
          <tbody>${d.newUsers.map((u) => userRow(u, false)).join('')}</tbody>
        </table>`
      : `<p class="empty">No new users in this window.</p>`;

    const returningTable = d.returningUsers.length
      ? `<table>
          <thead><tr><th scope="col">User</th><th scope="col" class="r">Sessions now</th><th scope="col" class="r">Lifetime</th><th scope="col">What they did</th><th scope="col" class="r">Failures</th><th scope="col">Joined</th><th scope="col">Screens</th></tr></thead>
          <tbody>${d.returningUsers.map((u) => userRow(u, true)).join('')}</tbody>
        </table>`
      : `<p class="empty">No returning users in this window.</p>`;

    const f = d.funnel;
    const funnelSection = f.sessions > 0 ? `
<h2>Where sessions dropped off</h2>
<table>
  <thead><tr><th scope="col">Stage</th><th scope="col" class="r">Reached</th><th scope="col" class="r">% of sessions</th><th scope="col" class="r">vs prev</th></tr></thead>
  <tbody>
    ${f.stages.map((s) => {
      const dlt = s.count - s.prev;
      const p = s.key === 'sessions' ? 100 : (f.sessions > 0 ? Math.round((s.count / f.sessions) * 100) : 0);
      return `<tr><td>${esc(s.label)}</td><td class="r">${esc(s.count)}</td><td class="r">${s.key === 'sessions' ? '' : esc(p + '%')}</td><td class="r">${esc((dlt > 0 ? '+' : '') + dlt)}</td></tr>`;
    }).join('')}
  </tbody>
</table>
${f.biggestLeak ? `<p class="meta">Biggest drop-off: <strong>${esc(f.biggestLeak.fromLabel)}</strong> to <strong>${esc(f.biggestLeak.toLabel)}</strong> (lost ${esc(f.biggestLeak.lost)}, ${esc(Math.round(f.biggestLeak.pct * 100) + '%')}).</p>` : ''}
<div class="cards">
  ${f.failures.map((x) => `<div class="card"><div class="num ${x.count > 0 ? 'bad' : ''}">${esc(x.count)}</div><div class="lbl">${esc(x.label)} fails (${(x.count - x.prev) >= 0 ? '+' : ''}${esc(x.count - x.prev)})</div></div>`).join('')}
</div>` : '';

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MenuVoice morning report (${esc(d.windowLabel)})</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.5rem; max-width: 1000px; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; border-bottom: 2px solid currentColor; padding-bottom: .2rem; }
  .meta { opacity: .7; font-size: .9rem; margin-bottom: 1rem; }
  .verdict { font-size: 1.15rem; padding: .8rem 1rem; border-radius: 10px; border: 2px solid; }
  .verdict.yes { border-color: #1e8449; }
  .verdict.no  { border-color: #c0392b; }
  .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: .75rem; }
  .card { border: 1px solid; border-radius: 10px; padding: .8rem 1rem; min-width: 110px; }
  .card.hl .num { color: #1e8449; }
  .num { font-size: 1.8rem; font-weight: 700; }
  .lbl { font-size: .8rem; opacity: .75; text-transform: uppercase; letter-spacing: .03em; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; font-size: .9rem; }
  th, td { text-align: left; padding: .35rem .55rem; border-bottom: 1px solid rgba(128,128,128,.3); }
  th { position: sticky; top: 0; background: Canvas; }
  td.r, th.r { text-align: right; }
  .small { font-size: .78rem; opacity: .8; }
  .empty { opacity: .7; font-style: italic; }
  .bad { color: #c0392b; font-weight: 600; }
  .nav a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>MenuVoice morning report</h1>
<p class="meta">Window: <strong>${esc(d.windowLabel)}</strong> &middot; generated ${esc(d.generated)}
 ${t.dataFrom ? `&middot; data ${esc(t.dataFrom)} &rarr; ${esc(t.dataTo)}` : ''}</p>
<p class="nav">View:
  <a href="?key=${esc(provided)}&hours=24">24 h</a>
  <a href="?key=${esc(provided)}&hours=48">48 h</a>
  <a href="?key=${esc(provided)}&days=7">7 days</a>
  &middot; <a href="?key=${esc(provided)}&format=text">plain text</a>
  &middot; <a href="/api/report?key=${esc(provided)}">full dashboard</a>
</p>

${verdict}

<div class="cards">
  ${card('New users', d.newUsers.length, 'hl')}
  ${card('Returning users', d.returningUsers.length)}
  ${card('Sessions', t.sessions)}
  ${card('Events', t.events)}
  ${card('Failures', t.failures)}
</div>

<h2>New users (${esc(d.newUsers.length)})</h2>
${newTable}

<h2>Returning users (${esc(d.returningUsers.length)})</h2>
${returningTable}

${funnelSection}

${d.excluded.length ? `<p class="meta">Excluded internal accounts: ${esc(d.excluded.join(', '))}</p>` : ''}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[morning] error:', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(
      `<!doctype html><meta charset="utf-8"><h1>Report error</h1><pre>${esc((err as Error).message)}</pre>`
    );
  }
}
