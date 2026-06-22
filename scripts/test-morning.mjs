// Validates the /api/morning queries against the live DB and prints the digest.
// Mirrors api/_morningData.ts buildMorningReport (exclusion + activity).
// Run: node scripts/test-morning.mjs [hours]
import { readFileSync } from 'node:fs';
import { createClient } from '@vercel/postgres';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2] ?? m[3] ?? '';
}
if (!process.env.POSTGRES_URL) { console.error('FAIL: POSTGRES_URL missing'); process.exit(1); }

const hours = Number(process.argv[2]) || 24;
const w = `now() - interval '${hours} hours'`;
const exclude = (process.env.REPORT_EXCLUDE_EMAILS ?? '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const notExcluded = `lower(user_email) <> ALL($1::text[])`;

const client = createClient();
await client.connect();
try {
  const headline = (await client.query(
    `SELECT count(*) AS events, count(DISTINCT session_id) AS sessions,
            count(DISTINCT user_email) FILTER (WHERE user_email IS NOT NULL AND ${notExcluded}) AS users,
            count(DISTINCT session_id) FILTER (WHERE user_email IS NULL) AS anon_sessions,
            count(*) FILTER (WHERE outcome='failure') AS failures
     FROM events WHERE ts > ${w} AND (user_email IS NULL OR ${notExcluded})`, [exclude])).rows[0];

  const users = (await client.query(
    `WITH win AS (
       SELECT user_email, count(*) AS events, count(DISTINCT session_id) AS sessions,
              min(ts) AS first_in_window, max(ts) AS last_in_window,
              count(*) FILTER (WHERE outcome='failure') AS failures,
              count(*) FILTER (WHERE event_name='ocr_result') AS menus,
              count(*) FILTER (WHERE event_name='llm_reply')  AS questions,
              count(*) FILTER (WHERE event_name='saved')      AS saves,
              count(*) FILTER (WHERE event_name IN ('search_start','find_by_name')) AS finds,
              array_agg(DISTINCT screen) FILTER (WHERE screen IS NOT NULL) AS screens
       FROM events WHERE user_email IS NOT NULL AND ${notExcluded} AND ts > ${w} GROUP BY user_email
     ),
     life AS (
       SELECT user_email, min(ts) AS first_ts, count(DISTINCT session_id) AS lifetime_sessions
       FROM events WHERE user_email IS NOT NULL AND ${notExcluded} GROUP BY user_email
     )
     SELECT win.*, life.first_ts, life.lifetime_sessions, (life.first_ts > ${w}) AS is_new
     FROM win JOIN life USING (user_email)
     ORDER BY is_new DESC, win.last_in_window DESC`, [exclude])).rows;

  console.log(`Window: last ${hours}h  | excluding: ${exclude.join(', ')}`);
  console.log('Headline:', headline);
  console.log('New users:', users.filter((u) => u.is_new));
  console.log('Returning users:', users.filter((u) => !u.is_new));
  console.log('\nQUERIES VALID ✔');
} finally {
  await client.end();
}
