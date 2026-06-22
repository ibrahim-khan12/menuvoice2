// Validates the /api/dashboard queries against the live DB and prints a summary.
// Run: node scripts/test-dashboard.mjs [hours]
import { readFileSync } from 'node:fs';
import { createClient } from '@vercel/postgres';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2] ?? m[3] ?? '';
}
if (!process.env.POSTGRES_URL) { console.error('FAIL: POSTGRES_URL missing'); process.exit(1); }

const hours = Number(process.argv[2]) || 24;
const w = `now() - interval '${hours} hours'`;
const prevStart = `now() - interval '${hours * 2} hours'`;
const bucketUnit = hours <= 72 ? 'hour' : 'day';
const bucketStep = bucketUnit === 'hour' ? '1 hour' : '1 day';

// Same exclusion as api/_morningData.ts excludeList(): drop configured internal/test accounts.
const exclude = (process.env.REPORT_EXCLUDE_EMAILS ?? '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const keep = `(user_email IS NULL OR lower(user_email) <> ALL($1::text[]))`;
const keepE = `(e.user_email IS NULL OR lower(e.user_email) <> ALL($1::text[]))`;
const keepSignedIn = `user_email IS NOT NULL AND lower(user_email) <> ALL($1::text[])`;

const client = createClient();
await client.connect();
try {
  const headline = (await client.query(`
    SELECT count(*) AS events, count(DISTINCT session_id) AS sessions,
           count(DISTINCT user_email) FILTER (WHERE user_email IS NOT NULL) AS users,
           count(DISTINCT session_id) FILTER (WHERE user_email IS NULL) AS anon_sessions,
           count(*) FILTER (WHERE outcome='failure') AS failures,
           min(ts) AS first_ts, max(ts) AS last_ts
    FROM events WHERE ts > ${w} AND ${keep}`, [exclude])).rows[0];

  const prev = (await client.query(`
    SELECT count(*) AS events, count(DISTINCT session_id) AS sessions,
           count(*) FILTER (WHERE outcome='failure') AS failures
    FROM events WHERE ts > ${prevStart} AND ts <= ${w} AND ${keep}`, [exclude])).rows[0];

  const series = (await client.query(`
    WITH buckets AS (
      SELECT generate_series(date_trunc('${bucketUnit}', ${w}),
             date_trunc('${bucketUnit}', now()), interval '${bucketStep}') AS bucket
    )
    SELECT b.bucket, count(e.id) AS events,
           count(DISTINCT e.session_id) AS sessions,
           count(e.id) FILTER (WHERE e.outcome='failure') AS failures
    FROM buckets b
    LEFT JOIN events e ON date_trunc('${bucketUnit}', e.ts) = b.bucket AND e.ts > ${w} AND ${keepE}
    GROUP BY b.bucket ORDER BY b.bucket`, [exclude])).rows;

  const funnel = (await client.query(`
    SELECT count(*) FILTER (WHERE event_name='camera_start') AS camera,
           count(*) FILTER (WHERE event_name='photo_added') AS photo,
           count(*) FILTER (WHERE event_name='analyze_start') AS analyze,
           count(*) FILTER (WHERE event_name='ocr_result' AND outcome='success') AS ocr_ok,
           count(*) FILTER (WHERE event_name='user_utterance') AS asked,
           count(*) FILTER (WHERE event_name='llm_reply') AS replied
    FROM events WHERE ts > ${w} AND ${keep}`, [exclude])).rows[0];

  const screens = (await client.query(`
    SELECT coalesce(screen,'(none)') AS screen, count(*) AS n,
           count(DISTINCT session_id) AS sessions,
           count(*) FILTER (WHERE outcome='failure') AS failures
    FROM events WHERE ts > ${w} AND ${keep} GROUP BY screen ORDER BY n DESC LIMIT 12`, [exclude])).rows;

  const topEvents = (await client.query(`
    SELECT event_type, event_name, count(*) AS n,
           count(*) FILTER (WHERE outcome='failure') AS failures,
           round(avg(duration_ms)) AS avg_ms
    FROM events WHERE ts > ${w} AND ${keep} GROUP BY event_type, event_name ORDER BY n DESC LIMIT 20`, [exclude])).rows;

  const users = (await client.query(`
    WITH win AS (
      SELECT user_email, count(*) AS events, count(DISTINCT session_id) AS sessions,
             count(*) FILTER (WHERE event_name='photo_added') AS photos,
             count(*) FILTER (WHERE event_name='user_utterance') AS asks,
             count(*) FILTER (WHERE event_name='llm_reply') AS replies,
             count(*) FILTER (WHERE outcome='failure') AS failures,
             max(ts) AS last_seen,
             array_agg(DISTINCT screen) FILTER (WHERE screen IS NOT NULL) AS screens
      FROM events WHERE ${keepSignedIn} AND ts > ${w} GROUP BY user_email
    ),
    life AS (
      SELECT user_email, min(ts) AS first_ts, count(DISTINCT session_id) AS lifetime_sessions
      FROM events WHERE ${keepSignedIn} GROUP BY user_email
    )
    SELECT win.*, life.first_ts, life.lifetime_sessions, (life.first_ts > ${w}) AS is_new
    FROM win JOIN life USING (user_email) ORDER BY win.last_seen DESC LIMIT 100`, [exclude])).rows;

  const recent = (await client.query(`
    SELECT ts, coalesce(user_email,'(anon)') AS user_email, screen, event_type,
           event_name, outcome, duration_ms, session_id
    FROM events WHERE ts > ${w} AND ${keep} ORDER BY ts DESC LIMIT 50`, [exclude])).rows;

  const failures = (await client.query(`
    SELECT ts, coalesce(user_email,'(anon)') AS user_email, screen, event_name, session_id, content
    FROM events WHERE outcome='failure' AND ts > ${w} AND ${keep} ORDER BY ts DESC LIMIT 30`, [exclude])).rows;

  console.log(`Window: last ${hours}h  (bucket by ${bucketUnit})  excluding: ${exclude.join(', ')}`);
  console.log('Headline:', headline);
  console.log('Prev window:', prev);
  console.log('Series buckets:', series.length, '| sample:', series.slice(0, 3));
  console.log('Funnel:', funnel);
  console.log('Top screens:', screens.length);
  console.log('Top events:', topEvents.length);
  console.log('Users:', users.length);
  console.log('Recent rows:', recent.length, '| Failures:', failures.length);
  console.log('\nALL 9 QUERIES VALID ✔');
} finally {
  await client.end();
}
