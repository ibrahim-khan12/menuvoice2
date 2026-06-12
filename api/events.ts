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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Always 200 — telemetry must never break the client.
  try {
    await ensureSchema();

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(200).json({ ok: true }); }
    }

    const rows: EventRow[] = Array.isArray(body?.events)
      ? (body.events as EventRow[]).slice(0, 100)
      : [];

    const valid = rows.filter((e) => e?.session_id && e?.event_type && e?.event_name);
    if (!valid.length) return res.status(200).json({ ok: true });

    await withClient(async (client) => {
      await Promise.all(
        valid.map((e) => {
          const contentStr = e.content != null ? JSON.stringify(e.content) : null;
          const metaStr = e.metadata != null ? JSON.stringify(e.metadata) : null;
          return client.query(
            `INSERT INTO events
              (client_ts, user_email, session_id, screen, event_type, event_name,
               outcome, duration_ms, content, metadata, app_version, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
            [
              e.client_ts ?? null, e.user_email ?? null, e.session_id,
              e.screen ?? null, e.event_type, e.event_name,
              e.outcome ?? null, e.duration_ms ?? null,
              contentStr, metaStr,
              e.app_version ?? null, e.user_agent ?? null,
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
