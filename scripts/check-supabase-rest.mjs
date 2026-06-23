// Verifies Supabase anon REST access cannot read the analytics table.
// Loads SUPABASE_URL and SUPABASE_ANON_KEY from .env.local.
// Run: node scripts/check-supabase-rest.mjs

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2] ?? m[3] ?? '';
}

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('FAIL: SUPABASE_URL or SUPABASE_ANON_KEY not found in .env.local');
  process.exit(1);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/events?select=id&limit=1`, {
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  },
});

const body = await res.text();
console.log('anon REST status:', res.status);
console.log('anon REST body:', body.slice(0, 300));

if (res.status === 200) {
  console.error('FAIL: anon REST can read events');
  process.exit(1);
}

console.log('OK: anon REST cannot read events');
