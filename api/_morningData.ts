// Shared logic for the morning report: pull the data, render it, send it.
// Used by api/morning.ts (on-demand view) and api/cron-morning.ts (daily email).
// Underscore prefix => Vercel does not expose this as an HTTP route.

import { createClient } from '@vercel/postgres';
// nodemailer is imported lazily inside sendEmail() (its only use). A top-level
// import pulls it into module load for EVERY consumer of this file — including the
// /api/morning and /api/dashboard view endpoints — and nodemailer failing to load
// in the Vercel runtime crashed those functions (FUNCTION_INVOCATION_FAILED).

export interface UserRow {
  user_email: string;
  events: number;
  sessions: number;
  first_in_window: string;
  last_in_window: string;
  failures: number;
  screens: string[] | null;
  menus: number;       // menus analyzed (ocr_result)
  questions: number;   // assistant replies (llm_reply)
  saves: number;       // restaurants saved
  finds: number;       // find-by-name searches
  first_ts: string;
  lifetime_sessions: number;
  is_new: boolean;
}

export interface MorningData {
  windowLabel: string;
  hours: number;
  generated: string;
  anyoneUsed: boolean;
  // Headline totals, derived only from identified users (no anonymous noise).
  totals: { users: number; sessions: number; events: number; failures: number; dataFrom: string; dataTo: string };
  newUsers: UserRow[];
  returningUsers: UserRow[];
  excluded: string[];
}

// Accounts we never want to see in the report (own testing). Override with the
// REPORT_EXCLUDE_EMAILS env var (comma-separated). Lower-cased + trimmed.
export function excludeList(): string[] {
  const raw = process.env.REPORT_EXCLUDE_EMAILS ?? '2firemaster27@gmail.com,avitaldrel@gmail.com';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export async function withClient<T>(fn: (c: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function fmtTs(ts: unknown): string {
  if (!ts) return '';
  const d = new Date(ts as string);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function ago(ts: unknown): string {
  if (!ts) return '';
  const then = new Date(ts as string).getTime();
  if (isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} mo ago` : `${Math.round(days / 365)} yr ago`;
}

export function esc(v: unknown): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One human-readable line of "what they did" for a user.
export function activity(u: UserRow): string {
  const parts: string[] = [];
  if (Number(u.menus) > 0) parts.push(`${u.menus} menu${Number(u.menus) === 1 ? '' : 's'} scanned`);
  if (Number(u.questions) > 0) parts.push(`${u.questions} question${Number(u.questions) === 1 ? '' : 's'} asked`);
  if (Number(u.finds) > 0) parts.push(`${u.finds} restaurant search${Number(u.finds) === 1 ? '' : 'es'}`);
  if (Number(u.saves) > 0) parts.push(`${u.saves} saved`);
  return parts.length ? parts.join(' · ') : 'browsed only';
}

export async function buildMorningReport(hours: number): Promise<MorningData> {
  hours = Math.min(Math.max(hours, 1), 24 * 365);
  const exclude = excludeList();
  const windowLabel = hours === 24 ? 'last 24 hours' : hours % 24 === 0 ? `last ${hours / 24} days` : `last ${hours} h`;
  const w = `now() - interval '${hours} hours'`;
  // Parameterized exclusion: $1 = lower-cased email array. Safe against injection.
  // NOTE: a session's pre-login rows have NULL email; the per-user query keys off
  // the rows that DO carry the email, so a logged-in user is counted once — there
  // is no separate "anonymous session" double-count.
  const notExcluded = `lower(user_email) <> ALL($1::text[])`;

  return withClient(async (client) => {
    const users = await client.query(
      `WITH win AS (
         SELECT user_email,
                count(*)                                   AS events,
                count(DISTINCT session_id)                 AS sessions,
                min(ts)                                    AS first_in_window,
                max(ts)                                    AS last_in_window,
                count(*) FILTER (WHERE outcome='failure')  AS failures,
                count(*) FILTER (WHERE event_name='ocr_result') AS menus,
                count(*) FILTER (WHERE event_name='llm_reply')  AS questions,
                count(*) FILTER (WHERE event_name='saved')      AS saves,
                count(*) FILTER (WHERE event_name IN ('search_start','find_by_name')) AS finds,
                array_agg(DISTINCT screen) FILTER (WHERE screen IS NOT NULL) AS screens
         FROM events
         WHERE user_email IS NOT NULL AND ${notExcluded} AND ts > ${w}
         GROUP BY user_email
       ),
       life AS (
         SELECT user_email, min(ts) AS first_ts, count(DISTINCT session_id) AS lifetime_sessions
         FROM events WHERE user_email IS NOT NULL AND ${notExcluded}
         GROUP BY user_email
       )
       SELECT win.*, life.first_ts, life.lifetime_sessions, (life.first_ts > ${w}) AS is_new
       FROM win JOIN life USING (user_email)
       ORDER BY is_new DESC, win.last_in_window DESC`,
      [exclude]
    );

    const rows = users.rows as UserRow[];
    const num = (v: unknown) => Number(v) || 0;
    const totals = {
      users: rows.length,
      sessions: rows.reduce((a, u) => a + num(u.sessions), 0),
      events: rows.reduce((a, u) => a + num(u.events), 0),
      failures: rows.reduce((a, u) => a + num(u.failures), 0),
      dataFrom: rows.length ? fmtTs(rows.reduce((min, u) => (u.first_in_window < min ? u.first_in_window : min), rows[0].first_in_window)) : '',
      dataTo: rows.length ? fmtTs(rows.reduce((max, u) => (u.last_in_window > max ? u.last_in_window : max), rows[0].last_in_window)) : '',
    };

    return {
      windowLabel,
      hours,
      generated: fmtTs(new Date().toISOString()),
      anyoneUsed: rows.length > 0,
      totals,
      newUsers: rows.filter((u) => u.is_new),
      returningUsers: rows.filter((u) => !u.is_new),
      excluded: exclude,
    };
  });
}

// ---- Renderers ----

export function renderText(d: MorningData): string {
  const t = d.totals;
  const lines: string[] = [];
  lines.push(`MenuVoice morning report  (${d.windowLabel})`);
  lines.push(`generated ${d.generated}`);
  lines.push('');
  if (!d.anyoneUsed) {
    lines.push('No one used MenuVoice in this window.');
  } else {
    lines.push(`Yes, MenuVoice was used by ${t.users} ${t.users === 1 ? 'person' : 'people'}.`);
    lines.push(`  ${t.sessions} session(s), ${t.events} event(s), ${t.failures} failure(s)`);
    lines.push('');
    lines.push(`NEW users (${d.newUsers.length}):`);
    if (!d.newUsers.length) lines.push('  (none)');
    for (const u of d.newUsers) {
      lines.push(`  - ${u.user_email}  |  ${u.sessions} session(s)  |  ${activity(u)}  |  first seen ${fmtTs(u.first_in_window)}`);
    }
    lines.push('');
    lines.push(`Returning users (${d.returningUsers.length}):`);
    if (!d.returningUsers.length) lines.push('  (none)');
    for (const u of d.returningUsers) {
      lines.push(`  - ${u.user_email}  |  ${u.sessions} session(s) now / ${u.lifetime_sessions} lifetime  |  ${activity(u)}  |  joined ${ago(u.first_ts)}`);
    }
  }
  lines.push('');
  if (d.excluded.length) lines.push(`(excluded internal accounts: ${d.excluded.join(', ')})`);
  return lines.join('\n');
}

// Palette
const C = {
  ink: '#0f172a', sub: '#64748b', line: '#e2e8f0', bg: '#f1f5f9',
  green: '#16a766', greenDk: '#0f7a4a', greenBg: '#e9f7f0',
  red: '#c0392b', redBg: '#fdecea', amber: '#b45309',
  card: '#ffffff', newBadge: '#16a766', retBadge: '#3b82f6',
};

function userCard(u: UserRow, kind: 'new' | 'returning'): string {
  const badge = kind === 'new'
    ? `<span style="display:inline-block;background:${C.newBadge};color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 8px;border-radius:999px;text-transform:uppercase">New</span>`
    : `<span style="display:inline-block;background:${C.retBadge};color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 8px;border-radius:999px;text-transform:uppercase">Returning</span>`;
  const meta = kind === 'new'
    ? `${u.sessions} session${Number(u.sessions) === 1 ? '' : 's'} &middot; first seen ${esc(fmtTs(u.first_in_window))}`
    : `${u.sessions} session${Number(u.sessions) === 1 ? '' : 's'} now &middot; ${esc(u.lifetime_sessions)} lifetime &middot; joined ${esc(ago(u.first_ts))}`;
  return `
  <tr><td style="padding:0 0 10px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px">
      <tr><td style="padding:14px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:15px;font-weight:700;color:${C.ink};font-family:Segoe UI,system-ui,-apple-system,sans-serif">${esc(u.user_email)}</td>
          <td align="right">${badge}</td>
        </tr></table>
        <div style="font-size:14px;color:${C.ink};margin:6px 0 4px;font-family:Segoe UI,system-ui,-apple-system,sans-serif">${esc(activity(u))}</div>
        <div style="font-size:12px;color:${C.sub};font-family:Segoe UI,system-ui,-apple-system,sans-serif">${meta}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderEmailHtml(d: MorningData, dashboardUrl?: string): string {
  const t = d.totals;
  const ff = 'Segoe UI,system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif';

  const verdict = d.anyoneUsed
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.greenBg};border:1px solid ${C.green};border-radius:12px">
         <tr><td style="padding:16px 18px;font-family:${ff}">
           <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.greenDk}">Yes — people used MenuVoice</div>
           <div style="font-size:28px;font-weight:800;color:${C.ink};margin-top:2px">${t.users} ${t.users === 1 ? 'person' : 'people'}</div>
           <div style="font-size:13px;color:${C.sub};margin-top:2px">${t.sessions} session${t.sessions === 1 ? '' : 's'} &middot; ${t.events} action${t.events === 1 ? '' : 's'}${Number(t.failures) > 0 ? ` &middot; <span style="color:${C.red}">${t.failures} failure${t.failures === 1 ? '' : 's'}</span>` : ''}</div>
         </td></tr>
       </table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.redBg};border:1px solid ${C.red};border-radius:12px">
         <tr><td style="padding:16px 18px;font-family:${ff}">
           <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.red}">Quiet window</div>
           <div style="font-size:20px;font-weight:800;color:${C.ink};margin-top:2px">No one used MenuVoice</div>
         </td></tr>
       </table>`;

  const tile = (label: string, value: number, accent: string) =>
    `<td width="50%" style="padding:0 6px">
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px">
         <tr><td style="padding:14px 16px;font-family:${ff}">
           <div style="font-size:32px;font-weight:800;color:${accent};line-height:1">${value}</div>
           <div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.sub};margin-top:4px">${label}</div>
         </td></tr>
       </table>
     </td>`;

  const section = (title: string, rows: UserRow[], kind: 'new' | 'returning') => `
    <tr><td style="padding:26px 0 8px;font-family:${ff};font-size:15px;font-weight:800;color:${C.ink};letter-spacing:.01em">${title} <span style="color:${C.sub};font-weight:600">(${rows.length})</span></td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows.length ? rows.map((u) => userCard(u, kind)).join('') : `<tr><td style="padding:12px 14px;background:${C.card};border:1px dashed ${C.line};border-radius:12px;color:${C.sub};font-size:13px;font-family:${ff}">None in this window.</td></tr>`}
      </table>
    </td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${C.bg}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%">

        <!-- header -->
        <tr><td style="background:${C.green};border-radius:14px 14px 0 0;padding:20px 22px;font-family:${ff}">
          <div style="font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#d6f5e6">MenuVoice</div>
          <div style="font-size:22px;font-weight:800;color:#ffffff;margin-top:2px">Morning report</div>
          <div style="font-size:12px;color:#c7efdb;margin-top:4px">${esc(d.windowLabel)} &middot; generated ${esc(d.generated)}</div>
        </td></tr>

        <!-- body -->
        <tr><td style="background:${C.bg};padding:18px 18px 24px;border:1px solid ${C.line};border-top:none;border-radius:0 0 14px 14px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td>${verdict}</td></tr>
            <tr><td style="padding-top:12px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px"><tr>
                ${tile('New users', d.newUsers.length, C.newBadge)}
                ${tile('Returning users', d.returningUsers.length, C.retBadge)}
              </tr></table>
            </td></tr>
            ${section('New users', d.newUsers, 'new')}
            ${section('Returning users', d.returningUsers, 'returning')}
            ${dashboardUrl ? `<tr><td style="padding-top:22px" align="center">
              <a href="${esc(dashboardUrl)}" style="display:inline-block;background:${C.ink};color:#fff;text-decoration:none;font-family:${ff};font-size:14px;font-weight:600;padding:11px 22px;border-radius:10px">Open full dashboard</a>
            </td></tr>` : ''}
            <tr><td style="padding-top:18px;font-family:${ff};font-size:11px;color:${C.sub};line-height:1.5">
              ${d.excluded.length ? `Internal/test accounts hidden: ${esc(d.excluded.join(', '))}.<br>` : ''}
              "New" = first-ever use in this window. "Returning" = used MenuVoice before and came back.
            </td></tr>
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ---- Email delivery ----
// Prefers Resend (RESEND_API_KEY, no SMTP egress needed); falls back to Gmail
// SMTP (GMAIL_USER + GMAIL_APP_PASSWORD). Throws if neither is configured.
export async function sendEmail(opts: { to: string; subject: string; html: string; text: string }): Promise<string> {
  const { to, subject, html, text } = opts;

  if (process.env.RESEND_API_KEY) {
    const from = process.env.RESEND_FROM ?? 'MenuVoice <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend failed: ${r.status} ${await r.text()}`);
    return 'resend';
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
    await transport.sendMail({ from: user, to, subject, text, html });
    return 'gmail';
  }

  throw new Error('No email transport configured. Set RESEND_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD.');
}
