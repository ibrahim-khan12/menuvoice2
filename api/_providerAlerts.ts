import { Redis } from '@upstash/redis';
import { reportEmailRecipients, sendEmail } from './_morningData.js';

const CARTESIA_ALERT_KEY = 'menuvoice:alerts:cartesia-credits';
const DEFAULT_ALERT_TTL_SECONDS = 6 * 60 * 60;

function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function alertWindowSeconds(): number {
  const raw = Number(process.env.CARTESIA_ALERT_COOLDOWN_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ALERT_TTL_SECONDS;
}

function alertRecipient(): string | null {
  return process.env.CARTESIA_ALERT_EMAIL_TO?.trim() || reportEmailRecipients() || null;
}

export function looksLikeCartesiaCreditIssue(status: number, detail: unknown): boolean {
  if (status === 402) return true;

  const text = String(detail ?? '').toLowerCase();
  if (!text) return false;
  return [
    'credit',
    'credits',
    'quota',
    'insufficient',
    'balance',
    'billing',
    'payment required',
    'usage limit',
    'limit exceeded',
    'out of funds',
  ].some((needle) => text.includes(needle));
}

async function shouldSendCartesiaAlert(): Promise<boolean> {
  const ttl = alertWindowSeconds();
  const redis = redisFromEnv();

  if (redis) {
    try {
      const key = `${CARTESIA_ALERT_KEY}:${new Date().toISOString().slice(0, 10)}`;
      const first = await redis.set(key, String(Date.now()), { nx: true, ex: ttl });
      return first === 'OK';
    } catch (error) {
      console.warn('[MenuVoice] Cartesia alert throttle unavailable:', error);
    }
  }

  const g = globalThis as typeof globalThis & { __menuvoiceCartesiaCreditAlertAt?: number };
  const now = Date.now();
  if (g.__menuvoiceCartesiaCreditAlertAt && now - g.__menuvoiceCartesiaCreditAlertAt < ttl * 1000) {
    return false;
  }
  g.__menuvoiceCartesiaCreditAlertAt = now;
  return true;
}

export async function maybeNotifyCartesiaCreditIssue(opts: {
  service: 'tts' | 'stt' | 'realtime-stt-token';
  status: number;
  detail: unknown;
}): Promise<void> {
  if (!looksLikeCartesiaCreditIssue(opts.status, opts.detail)) return;

  try {
    if (!(await shouldSendCartesiaAlert())) return;

    const generated = new Date().toISOString();
    const detail = String(opts.detail ?? '').slice(0, 1200);
    const text = [
      'MenuVoice detected a Cartesia credit or quota failure.',
      '',
      `Service: ${opts.service}`,
      `HTTP status: ${opts.status}`,
      `Time: ${generated}`,
      '',
      'Upstream response:',
      detail || '(empty response)',
      '',
      'Action: check the Cartesia account credits, quota, and billing status.',
    ].join('\n');

    const html = `<!doctype html><html><body>
      <p>MenuVoice detected a Cartesia credit or quota failure.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        <tr><td><strong>Service</strong></td><td>${opts.service}</td></tr>
        <tr><td><strong>HTTP status</strong></td><td>${opts.status}</td></tr>
        <tr><td><strong>Time</strong></td><td>${generated}</td></tr>
      </table>
      <p><strong>Upstream response</strong></p>
      <pre style="white-space:pre-wrap">${detail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
      <p>Action: check the Cartesia account credits, quota, and billing status.</p>
    </body></html>`;

    const to = alertRecipient();
    if (!to) {
      console.warn('[MenuVoice] Cartesia credit alert skipped: no CARTESIA_ALERT_EMAIL_TO or REPORT_EMAIL_TO configured.');
      return;
    }

    const via = await sendEmail({
      to,
      subject: 'MenuVoice Cartesia credits may be exhausted',
      text,
      html,
    });
    console.warn(`[MenuVoice] Cartesia credit alert sent via ${via}.`);
  } catch (error) {
    console.warn('[MenuVoice] Cartesia credit alert failed:', error);
  }
}
