import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Apple uses the clean registered callback URL on web and native', () => {
  const web = fs.readFileSync(path.join(root, 'src/lib/appleAuthWeb.ts'), 'utf8');
  const native = fs.readFileSync(path.join(root, 'src/lib/nativeAppleAuth.ts'), 'utf8');
  const expected = 'https://app.meetmymenu.com/api/sync';

  assert.match(web, new RegExp(`REDIRECT_URI = '${expected}'`));
  assert.match(native, new RegExp(`REDIRECT_PAGE = '${expected}'`));
  assert.doesNotMatch(web, /action=apple-callback/);
  assert.doesNotMatch(native, /action=apple-callback/);
});

test('the shared sync function recognizes Apple form posts without a query action', () => {
  const sync = fs.readFileSync(path.join(root, 'api/sync.ts'), 'utf8');

  assert.match(sync, /typeof appleBody\.id_token === 'string'/);
  assert.match(sync, /typeof appleBody\.error === 'string'/);
  assert.match(sync, /req\.query\.action !== 'session'/);
});
