// Cartesia API key rotation.
//
// Cartesia free/credit accounts run dry quickly, so we let the app hold several
// keys and fail over to the next one the moment a key hits a credit/quota wall.
// OpenAI is still the final fallback (handled by each caller) once every Cartesia
// key is exhausted.
//
// Keys are read from any of:
//   CARTESIA_API_KEYS   — comma-separated list ("sk_car_a, sk_car_b")
//   CARTESIA_API_KEY    — single key (back-compat)
//   CARTESIA_API_KEY_1..CARTESIA_API_KEY_10 — numbered keys

import { looksLikeCartesiaCreditIssue, maybeNotifyCartesiaCreditIssue } from './_providerAlerts.js';

export function cartesiaApiKeys(): string[] {
  const out: string[] = [];
  const add = (v?: string) => {
    if (!v) return;
    for (const part of v.split(',')) {
      const k = part.trim();
      if (k) out.push(k);
    }
  };
  add(process.env.CARTESIA_API_KEYS);
  add(process.env.CARTESIA_API_KEY);
  for (let i = 1; i <= 10; i += 1) add(process.env[`CARTESIA_API_KEY_${i}`]);
  return Array.from(new Set(out));
}

// Keys we've seen hit a credit/quota wall, with when we saw it. Lets us skip a
// dead key on the next request instead of paying its failure latency again.
// In-memory only: persists within a warm serverless instance, resets on cold
// start (which also gives an exhausted key a fresh chance after a refill).
const exhaustedAt = new Map<string, number>();
const EXHAUSTED_TTL_MS = 6 * 60 * 60 * 1000;

function isExhausted(key: string): boolean {
  const at = exhaustedAt.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > EXHAUSTED_TTL_MS) {
    exhaustedAt.delete(key);
    return false;
  }
  return true;
}

/**
 * Calls `attempt` once per Cartesia key, rotating to the next key whenever the
 * current one fails with a credit/quota error. Returns:
 *   - the first response that is NOT a credit failure (a success, or a real
 *     error like bad input that another key wouldn't fix), or
 *   - null when every key is out of credits — the caller should then fall back
 *     to OpenAI.
 * Emails a single credit alert only once all keys are exhausted.
 */
export async function withCartesiaKey(
  service: 'tts' | 'stt' | 'realtime-stt-token',
  attempt: (key: string) => Promise<Response>,
): Promise<Response | null> {
  const keys = cartesiaApiKeys();
  if (keys.length === 0) return null;

  // Healthy keys first; previously-exhausted keys last (their credits may have
  // refilled since we marked them).
  const ordered = [
    ...keys.filter((k) => !isExhausted(k)),
    ...keys.filter((k) => isExhausted(k)),
  ];

  let lastCreditStatus = 0;
  let lastCreditDetail: string | undefined;

  for (const key of ordered) {
    let res: Response;
    try {
      res = await attempt(key);
    } catch (error) {
      // Transport failure on this key — try the next one.
      lastCreditDetail = String((error as Error)?.message ?? error);
      continue;
    }

    if (res.ok) {
      exhaustedAt.delete(key);
      return res;
    }

    const detail = await res.clone().text().catch(() => '');
    if (looksLikeCartesiaCreditIssue(res.status, detail)) {
      exhaustedAt.set(key, Date.now());
      lastCreditStatus = res.status;
      lastCreditDetail = detail;
      continue; // rotate to the next key
    }

    // Non-credit error (bad request, upstream 5xx). Other keys would fail the
    // same way, so hand this response back instead of burning the rest.
    return res;
  }

  // Every key is out of credits/quota. Alert once, then signal "fall back".
  if (lastCreditStatus) {
    await maybeNotifyCartesiaCreditIssue({ service, status: lastCreditStatus, detail: lastCreditDetail });
  }
  return null;
}
