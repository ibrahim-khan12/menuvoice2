// Live verification of the analytics database.
// Loads POSTGRES_URL from .env.local, ensures the events schema exists,
// inserts a test event, reads it back, and cleans it up.
// Run: node scripts/test-db.mjs

import { readFileSync } from 'node:fs';
import { createClient } from '@vercel/postgres';

// Minimal .env.local loader (no dotenv dependency).
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2] ?? m[3] ?? '';
}

process.env.POSTGRES_URL = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

if (!process.env.POSTGRES_URL) {
  console.error('FAIL: POSTGRES_URL not found in .env.local');
  process.exit(1);
}

const client = createClient();
await client.connect();

try {
  // Same DDL as api/events.ts ensureSchema()
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
  console.log('OK: schema present');

  await Promise.all([
    client.query('ALTER TABLE events ENABLE ROW LEVEL SECURITY'),
    client.query('REVOKE ALL ON TABLE events FROM anon, authenticated'),
    client.query('REVOKE ALL ON SEQUENCE events_id_seq FROM anon, authenticated'),
  ]);
  console.log('OK: RLS enabled and API roles revoked');

  const sid = `dbtest-${Date.now()}`;
  await client.query(
    `INSERT INTO events (client_ts, session_id, screen, event_type, event_name, outcome, content)
     VALUES (now(), $1, 'test', 'test', 'db_verify', 'success', '{"from":"scripts/test-db.mjs"}'::jsonb)`,
    [sid]
  );
  console.log('OK: insert');

  const { rows } = await client.query('SELECT id, event_name, content FROM events WHERE session_id = $1', [sid]);
  if (rows.length !== 1 || rows[0].event_name !== 'db_verify') {
    console.error('FAIL: read-back mismatch', rows);
    process.exit(1);
  }
  console.log('OK: read-back', rows[0]);

  await client.query('DELETE FROM events WHERE session_id = $1', [sid]);
  console.log('OK: cleanup');

  const { rows: stats } = await client.query(
    `SELECT event_type, count(*)::int AS n FROM events GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
  );
  console.log('Existing event counts by type:', stats);
  console.log('\nDATABASE VERIFIED ✔');
} finally {
  await client.end();
}
