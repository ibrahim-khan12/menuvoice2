// Live verification that the OpenAI Responses API web_search tool works with
// the configured key and model — the backbone of api/find-menu.ts.
// Run: node scripts/test-find-menu.mjs ["Restaurant name, city"]

import { readFileSync } from 'node:fs';

for (const file of ['../.env.local', '../.env']) {
  try {
    for (const line of readFileSync(new URL(file, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2] ?? m[3] ?? '';
    }
  } catch {}
}

// Prefer the explicit override, else server key, else the local-dev Vite key.
const key = process.env.TEST_OPENAI_KEY ?? process.env.OPENAI_API_KEY ?? process.env.VITE_OPENAI_API_KEY;
if (!key) {
  console.error('FAIL: no OpenAI key found in .env.local / .env');
  process.exit(1);
}
console.log(`Using key source: ${process.env.TEST_OPENAI_KEY ? 'TEST_OPENAI_KEY' : process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : 'VITE_OPENAI_API_KEY'}`);

const MODEL = process.env.SEARCH_MODEL ?? 'gpt-5.4-mini';
const query = process.argv[2] ?? "McAlister's Deli, Bloomington Indiana";

console.log(`Model: ${MODEL}\nQuery: ${query}\nCalling /v1/responses with web_search…`);
const t0 = Date.now();

const res = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    tools: [{ type: 'web_search' }],
    input:
      `Find the restaurant "${query}" and its current food menu online. ` +
      'Extract up to 10 real menu items you can actually read, with prices. ' +
      'Respond ONLY with JSON: {"found":boolean,"restaurantName":string|null,"menuUrl":string|null,' +
      '"categories":[{"name":string,"items":[{"name":string,"price":string}]}],"reason":string}',
  }),
});

console.log(`HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const data = await res.json();

if (!res.ok) {
  console.error('FAIL:', JSON.stringify(data?.error ?? data, null, 2).slice(0, 1500));
  process.exit(1);
}

let text = typeof data.output_text === 'string' ? data.output_text : '';
if (!text) {
  for (const item of data.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text') text += part.text;
    }
  }
}

const cleaned = text.replace(/```[a-z]*\n?/gi, '').trim();
const start = cleaned.indexOf('{');
const end = cleaned.lastIndexOf('}');
const parsed = JSON.parse(cleaned.slice(start, end + 1));
const items = (parsed.categories ?? []).reduce((n, c) => n + (c.items?.length ?? 0), 0);
console.log(`found=${parsed.found} restaurant=${parsed.restaurantName} menuUrl=${parsed.menuUrl}`);
console.log(`categories=${(parsed.categories ?? []).length} items=${items}`);
if (items > 0) console.log('Sample items:', JSON.stringify(parsed.categories[0].items.slice(0, 3), null, 2));
console.log('\nWEB SEARCH VERIFIED ✔');
