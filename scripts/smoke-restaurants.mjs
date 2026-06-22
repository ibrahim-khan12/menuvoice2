// Black-box smoke test of MenuVoice production menu pipeline.
// Usage: node scripts/smoke-restaurants.mjs
// Plain Node 18+, no dependencies. Requests run SEQUENTIALLY, 60s timeout each.

const BASE = 'https://menuvoice-sigma.vercel.app';
const TIMEOUT_MS = 60_000;

const FIND_QUERIES = [
  { label: 'national chain', query: 'Olive Garden' },
  { label: 'fast-food chain', query: 'Panda Express' },
  { label: 'local + city', query: "Lou Malnati's, Chicago" },
  { label: 'coffee shop', query: 'Dunkin' },
  { label: 'JS-app website', query: "McAlister's Deli" },
  { label: 'fake restaurant', query: 'Zzyzx Quantum Bistro, Nowhere' },
];

const URL_CASES = [
  { label: 'HTML menu page', url: 'https://www.loumalnatis.com/menu/' },
  { label: 'HTML menu page 2', url: 'https://www.osf.com/menu/' },
  { label: 'PDF menu', url: 'https://superdawg.com/wp-content/uploads/2025/12/print-menu-Chicago-11_2025.pdf' },
];

function itemCount(menu) {
  if (!menu || !Array.isArray(menu.categories)) return 0;
  return menu.categories.reduce(
    (n, c) => n + (Array.isArray(c?.items) ? c.items.length : 0),
    0,
  );
}

async function post(path, body) {
  const started = Date.now();
  let status = 0;
  let json = null;
  let errText = '';
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      errText = `non-JSON body: ${text.slice(0, 120)}`;
    }
  } catch (e) {
    errText = e?.name === 'TimeoutError' ? `client timeout after ${TIMEOUT_MS} ms` : String(e?.message ?? e);
  }
  const ms = Date.now() - started;
  return { status, ms, json, errText };
}

function summarize(label, input, r) {
  const menu = r.json?.menu;
  const count = itemCount(menu);
  const restaurantName = r.json?.restaurantName ?? menu?.restaurantName ?? null;
  const via = r.json?.via ?? null;
  const incomplete = menu && 'incomplete' in menu ? menu.incomplete : null;
  const error = r.errText || r.json?.error || '';
  return { label, input, status: r.status, ms: r.ms, count, restaurantName, via, incomplete, error };
}

function row(o) {
  return [
    o.label,
    o.input,
    o.status || 'ERR',
    `${o.ms}ms`,
    o.count,
    o.restaurantName ?? '-',
    o.via ?? '-',
    o.incomplete === null ? '-' : String(o.incomplete),
    o.error ? o.error.slice(0, 100) : '-',
  ].join(' | ');
}

const results = [];

console.log('== /api/find-menu ==');
for (const { label, query } of FIND_QUERIES) {
  process.stderr.write(`  ${query} ... `);
  const r = await post('/api/find-menu', { query });
  const s = summarize(label, query, r);
  results.push({ endpoint: 'find-menu', ...s });
  process.stderr.write(`${s.status} in ${s.ms}ms, ${s.count} items\n`);
}

console.log('== /api/menu-from-url ==');
for (const { label, url } of URL_CASES) {
  process.stderr.write(`  ${url} ... `);
  const r = await post('/api/menu-from-url', { url });
  const s = summarize(label, url, r);
  results.push({ endpoint: 'menu-from-url', ...s });
  process.stderr.write(`${s.status} in ${s.ms}ms, ${s.count} items\n`);
}

console.log('\nendpoint | label | input | status | elapsed | items | restaurantName | via | incomplete | error');
for (const o of results) console.log(`${o.endpoint} | ${row(o)}`);

console.log('\nJSON_RESULTS_START');
console.log(JSON.stringify(results, null, 2));
console.log('JSON_RESULTS_END');
