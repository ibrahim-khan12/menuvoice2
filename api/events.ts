import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@vercel/postgres';

let schemaReady = false;

async function withClient<T>(fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureSchema() {
  if (schemaReady) return;
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id           BIGSERIAL PRIMARY KEY,
        ts           TIMESTAMPTZ  NOT NULL DEFAULT now(),
        client_ts    TIMESTAMPTZ,
        user_email   TEXT,
        session_id   TEXT NOT NULL,
        screen       TEXT,
        event_type   TEXT NOT NULL,
        event_name   TEXT NOT NULL,
        outcome      TEXT,
        duration_ms  INTEGER,
        content      JSONB,
        metadata     JSONB,
        app_version  TEXT,
        user_agent   TEXT
      )
    `);
    await client.query('ALTER TABLE events ENABLE ROW LEVEL SECURITY');
    await client.query('REVOKE ALL ON TABLE events FROM anon, authenticated');
    await client.query('REVOKE ALL ON SEQUENCE events_id_seq FROM anon, authenticated');
    await Promise.all([
      client.query('CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events (user_email, ts DESC)'),
      client.query('CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (event_type, event_name, ts DESC)'),
      client.query('CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, ts)'),
      client.query("CREATE INDEX IF NOT EXISTS idx_events_outcome ON events (outcome) WHERE outcome = 'failure'"),
    ]);
  });
  schemaReady = true;
}

interface EventRow {
  client_ts?: string;
  user_email?: string;
  session_id: string;
  screen?: string;
  event_type: string;
  event_name: string;
  outcome?: string;
  duration_ms?: number;
  content?: unknown;
  metadata?: unknown;
  app_version?: string;
  user_agent?: string;
}

// Clamp a string field to a max length (or null). Caps how much a single event
// can write to paid Postgres so a hostile client cannot store megabytes per row.
const s = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length ? v.slice(0, max) : null;

// Serialize content/metadata, capped. Oversized payloads are truncated to a
// marker rather than stored verbatim.
function jsonCapped(v: unknown, max: number): string | null {
  if (v == null) return null;
  try {
    const str = JSON.stringify(v);
    return str.length > max ? JSON.stringify({ truncated: true, len: str.length }) : str;
  } catch {
    return null;
  }
}

const CAPACITOR_ORIGIN = 'capacitor://localhost';

export function isAllowedEventOrigin(host: string | undefined, source: string): boolean {
  if (!host || !source) return true;
  if (source === CAPACITOR_ORIGIN || source.startsWith(`${CAPACITOR_ORIGIN}/`)) return true;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

// Web traffic must come from the deployment host. The signed native bundle is
// served from capacitor://localhost, so allow exactly that custom origin too.
function originAllowed(req: VercelRequest): boolean {
  const host = req.headers.host;
  const src = (req.headers.origin || req.headers.referer || '') as string;
  return isAllowedEventOrigin(host, src);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestOrigin = String(req.headers.origin || '');
  if (requestOrigin === CAPACITOR_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CAPACITOR_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  // Same-origin only — no permissive CORS. sendBeacon to same origin needs none.
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  if (!originAllowed(req)) return res.status(200).json({ ok: true });

  // Always 200 — telemetry must never break the client.
  try {
    await ensureSchema();

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(200).json({ ok: true }); }
    }

    const rows: EventRow[] = Array.isArray(body?.events)
      ? (body.events as EventRow[]).slice(0, 50)
      : [];

    const valid = rows.filter((e) => e?.session_id && e?.event_type && e?.event_name);
    if (!valid.length) return res.status(200).json({ ok: true });

    await withClient(async (client) => {
      // allSettled: one malformed row must not discard the whole batch.
      await Promise.allSettled(
        valid.map((e) => {
          const clientTs =
            typeof e.client_ts === 'string' && !isNaN(Date.parse(e.client_ts)) ? e.client_ts : null;
          const durationMs = Number.isFinite(e.duration_ms as number)
            ? Math.round(e.duration_ms as number)
            : null;
          return client.query(
            `INSERT INTO events
              (client_ts, user_email, session_id, screen, event_type, event_name,
               outcome, duration_ms, content, metadata, app_version, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
            [
              clientTs, s(e.user_email, 254), s(e.session_id, 128),
              s(e.screen, 64), s(e.event_type, 64), s(e.event_name, 64),
              s(e.outcome, 32), durationMs,
              jsonCapped(e.content, 8_000), jsonCapped(e.metadata, 8_000),
              s(e.app_version, 32), s(e.user_agent, 512),
            ]
          );
        })
      );
    });
  } catch (err) {
    console.error('[events] ingest error:', err);
  }

  return res.status(200).json({ ok: true });
}
