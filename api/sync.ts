import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { createClient } from '@vercel/postgres';
import { verifyGoogleIdToken, verifyAppleIdToken, createSessionToken, verifySessionToken, bearerToken } from '../server/auth.js';

// GET  /api/sync   — fetch stored data for the authenticated caller
// POST /api/sync   — save data { profile, restaurants } for the authenticated caller
//
// Authorization: Bearer <sessionToken> is REQUIRED on both. The session token
// (minted by /api/sync?action=session after verifying a real Google sign-in) is the
// only source of identity here — a client can no longer read or overwrite
// another account's data by naming its email, because the email now comes
// from the verified token, never from the request body or query string.

function emailKey(email: string) {
  return `user:${email.trim().toLowerCase()}`;
}

let snapshotSchemaReady = false;

function hasPostgres(): boolean {
  return !!process.env.POSTGRES_URL;
}

async function withClient<T>(fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T | null> {
  if (!hasPostgres()) return null;
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureSnapshotSchema() {
  if (snapshotSchemaReady || !hasPostgres()) return;
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_state_snapshots (
        email TEXT PRIMARY KEY,
        profile JSONB,
        restaurants JSONB,
        restaurant_count INTEGER NOT NULL DEFAULT 0,
        dining_history_count INTEGER NOT NULL DEFAULT 0,
        last_saved_restaurant_at TIMESTAMPTZ,
        last_opened_restaurant_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('ALTER TABLE user_state_snapshots ENABLE ROW LEVEL SECURITY');
    await client.query('REVOKE ALL ON TABLE user_state_snapshots FROM anon, authenticated');
    await Promise.all([
      client.query('CREATE INDEX IF NOT EXISTS idx_user_state_updated_at ON user_state_snapshots (updated_at DESC)'),
      client.query('CREATE INDEX IF NOT EXISTS idx_user_state_last_opened_at ON user_state_snapshots (last_opened_restaurant_at DESC)'),
    ]);
  });
  snapshotSchemaReady = true;
}

function latestIso(values: unknown[]): string | null {
  let latest = 0;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const t = Date.parse(value);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest ? new Date(latest).toISOString() : null;
}

function stateStats(profile: unknown, restaurants: unknown) {
  const list = Array.isArray(restaurants) ? restaurants as Array<Record<string, unknown>> : [];
  const profileObj = profile && typeof profile === 'object' ? profile as Record<string, unknown> : {};
  return {
    restaurantCount: list.length,
    diningHistoryCount: Array.isArray(profileObj.diningHistory) ? profileObj.diningHistory.length : 0,
    lastSavedAt: latestIso(list.flatMap((r) => [r.updatedAt, r.createdAt, r.capturedAt])),
    lastOpenedAt: latestIso(list.map((r) => r.lastOpenedAt)),
  };
}

async function readSnapshot(email: string) {
  if (!hasPostgres()) return null;
  await ensureSnapshotSchema();
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT profile, restaurants, updated_at AS "updatedAt"
       FROM user_state_snapshots
       WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    return rows[0] ?? null;
  });
}

async function writeSnapshot(email: string, profile: unknown, restaurants: unknown): Promise<boolean> {
  if (!hasPostgres()) return false;
  await ensureSnapshotSchema();
  const stats = stateStats(profile, restaurants);
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO user_state_snapshots
         (email, profile, restaurants, restaurant_count, dining_history_count,
          last_saved_restaurant_at, last_opened_restaurant_at, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, now())
       ON CONFLICT (email) DO UPDATE SET
         profile = EXCLUDED.profile,
         restaurants = EXCLUDED.restaurants,
         restaurant_count = EXCLUDED.restaurant_count,
         dining_history_count = EXCLUDED.dining_history_count,
         last_saved_restaurant_at = EXCLUDED.last_saved_restaurant_at,
         last_opened_restaurant_at = EXCLUDED.last_opened_restaurant_at,
         updated_at = now()`,
      [
        email.trim().toLowerCase(),
        JSON.stringify(profile ?? null),
        JSON.stringify(Array.isArray(restaurants) ? restaurants : []),
        stats.restaurantCount,
        stats.diningHistoryCount,
        stats.lastSavedAt,
        stats.lastOpenedAt,
      ],
    );
  });
  return true;
}

// Web calls to /api/sync are same-origin (see apiUrl.ts), so the only real
// cross-origin caller is the signed native app, served from this custom
// scheme. Matches the allowlist api/tts.ts and api/events.ts already use —
// a bare '*' here would let any third-party site's JS read this endpoint's
// responses (session tokens, profile/restaurant data) via a visiting user's
// browser instead of only the app's own native shell.
const CAPACITOR_ORIGIN = 'capacitor://localhost';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestOrigin = String(req.headers.origin || '');
  if (requestOrigin === CAPACITOR_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CAPACITOR_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Apple's "Sign in with Apple" web flow POSTs the result to the registered
  // redirect_uri (response_mode=form_post is required whenever an id_token
  // is requested) — unlike Google's implicit flow, the token never lands in
  // a URL fragment a static page could read, so this needs a real POST
  // handler. Folded in here (rather than its own api/apple-callback.ts)
  // for the same Hobby-plan function-count reason the session action below
  // is folded in: a standalone file for this pushed the project over
  // Vercel's function limit, which silently kept the previous deployment
  // live instead of the one containing this endpoint.
  const appleBody = (req.body ?? {}) as { id_token?: string; state?: string; error?: string };
  const isAppleCallback =
    req.method === 'POST' &&
    req.query.action !== 'session' &&
    (typeof appleBody.id_token === 'string' || typeof appleBody.error === 'string');
  if (isAppleCallback) {
    const body = appleBody;
    const params = new URLSearchParams();
    if (body.id_token) params.set('id_token', body.id_token);
    if (body.state) params.set('state', body.state);
    if (body.error) params.set('error', body.error);
    const redirectUrl = `com.meetmymenu.app://apple-oauth-callback#${params.toString()}`;
    res.setHeader('Content-Type', 'text/html');
    // A same-document JS redirect (not a 302) because some in-app/system
    // browser contexts don't reliably follow a server redirect to a custom
    // scheme, but do follow this.
    return res.status(200).send(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signing in&hellip;</title></head>` +
      `<body><p>Signing in&hellip;</p><script>window.location.replace(${JSON.stringify(redirectUrl)});</script></body></html>`,
    );
  }

  // Keep session creation in this existing function so the Hobby deployment
  // stays within Vercel's function limit. It remains a distinct API action.
  if (req.method === 'POST' && req.query.action === 'session') {
    const { idToken, provider } = (req.body ?? {}) as { idToken?: string; provider?: string };
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'idToken required' });
    }
    const identity =
      provider === 'apple' ? await verifyAppleIdToken(idToken) : await verifyGoogleIdToken(idToken);
    if (!identity) {
      return res.status(401).json({ error: 'Could not verify that sign-in. Please try signing in again.' });
    }
    try {
      const sessionToken = await createSessionToken(identity.email);
      return res.status(200).json({ sessionToken, email: identity.email });
    } catch (error) {
      console.error('[Meet My Menu AI] session token creation failed:', error);
      return res.status(500).json({ error: 'Sign-in is not fully configured on the server.' });
    }
  }

  const token = bearerToken(req.headers.authorization);
  const identity = token ? await verifySessionToken(token) : null;
  if (!identity) {
    return res.status(401).json({ error: 'Sign in again to sync your saved restaurants.' });
  }
  const email = identity.email;

  if (req.method === 'GET') {
    let data: unknown = null;
    try {
      data = await kv.get(emailKey(email));
    } catch (error) {
      console.warn('[sync] KV read failed, trying Postgres snapshot:', error);
    }
    if (!data) {
      data = await readSnapshot(email).catch((error) => {
        console.warn('[sync] Postgres snapshot read failed:', error);
        return null;
      });
    }
    return res.status(200).json(data ?? null);
  }

  if (req.method === 'POST') {
    // email deliberately NOT read from req.body — identity comes only from
    // the verified session token above, never from anything the client sends.
    const { profile, restaurants } = req.body ?? {};
    const state = { profile, restaurants, updatedAt: Date.now() };
    let saved = false;
    try {
      await kv.set(emailKey(email), state);
      saved = true;
    } catch (error) {
      console.warn('[sync] KV write failed:', error);
    }
    try {
      saved = (await writeSnapshot(email, profile, restaurants)) || saved;
    } catch (error) {
      console.warn('[sync] Postgres snapshot write failed:', error);
    }
    if (!saved) return res.status(500).json({ ok: false, error: 'sync failed' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
