// GET /api/cron-morning   ->  builds the morning report and EMAILS it.
//
// Triggered automatically by Vercel Cron (see vercel.json "crons"). Vercel sends
// `Authorization: Bearer $CRON_SECRET` on scheduled invocations; we verify it.
// You can also trigger manually with ?key=<REPORT_KEY> (e.g. to test delivery).
//
// Recipient:  REPORT_EMAIL_TO
// Transport:  RESEND_API_KEY  OR  GMAIL_USER + GMAIL_APP_PASSWORD  (see _morningData.sendEmail)
// Window:     REPORT_EMAIL_HOURS (default 24).  ?hours= overrides for manual runs.
//
// Internal/test accounts are excluded via REPORT_EXCLUDE_EMAILS.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildMorningReport, renderText, renderEmailHtml, sendEmail, reportEmailRecipients } from './_morningData.js';

function authorized(req: VercelRequest): boolean {
  const auth = (req.headers.authorization as string) ?? '';
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (process.env.REPORT_KEY && (req.query.key as string) === process.env.REPORT_KEY.trim()) return true;
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const to = reportEmailRecipients();
  const hoursRaw = Number(req.query.hours);
  const envHours = Number(process.env.REPORT_EMAIL_HOURS);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? hoursRaw
    : Number.isFinite(envHours) && envHours > 0
      ? envHours
      : 24;

  // If no server-side transport is set, this path is a clean no-op (200) — the
  // active sender is the scheduled cloud agent hitting /api/morning?format=email.
  const hasTransport = !!(process.env.RESEND_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
  if (!hasTransport) {
    return res.status(200).json({ ok: true, sent: false, reason: 'no server transport configured; cloud agent handles delivery' });
  }
  if (!to) {
    return res.status(500).json({ ok: false, error: 'REPORT_EMAIL_TO is required when email transport is configured' });
  }

  try {
    const d = await buildMorningReport(hours);

    // Don't email a "nothing happened" report. If no one used MenuVoice in the
    // window there is nothing new to say, so we skip the send entirely (a clean
    // 200 no-op). Append ?force=1 to override (useful for manual test sends).
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!d.anyoneUsed && !force) {
      return res.status(200).json({ ok: true, sent: false, reason: 'no activity in window — nothing new to report' });
    }

    const date = new Date().toISOString().slice(0, 10);
    // Stable, unique tag so a Gmail filter can label every report reliably.
    const subject = d.anyoneUsed
      ? `[MenuVoice] Morning report ${date} — ${d.newUsers.length} new, ${d.returningUsers.length} returning, ${d.website.visits} site visits`
      : `[MenuVoice] Morning report ${date} — no users in window`;

    const host = req.headers.host;
    const dashboardUrl = host && process.env.REPORT_KEY
      ? `https://${host}/api/morning?key=${process.env.REPORT_KEY}`
      : undefined;

    const via = await sendEmail({
      to,
      subject,
      html: renderEmailHtml(d, dashboardUrl),
      text: renderText(d),
    });

    return res.status(200).json({
      ok: true,
      sent_to: to,
      via,
      window: d.windowLabel,
      new_users: d.newUsers.length,
      returning_users: d.returningUsers.length,
      anyone_used: d.anyoneUsed,
    });
  } catch (err) {
    console.error('[cron-morning] error:', err);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
