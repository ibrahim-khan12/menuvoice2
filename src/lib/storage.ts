// Local persistence with localStorage + cloud sync via /api/sync.
// SavedRestaurant carries its own id + capturedAt so a future V2 "shared menus
// across users" feature needs no migration.

import { UserProfile, EMPTY_PROFILE, SavedRestaurant, ParsedMenu, MenuProvenance } from '../types';
import { track } from './telemetry';
import { apiUrl } from './apiUrl';

const PROFILE_KEY = 'menuvoice.profile.v1';
const SAVED_KEY = 'menuvoice.savedRestaurants.v1';
const SYNC_SESSION_KEY = 'menuvoice.syncSession.v1';
const MAX_DINING_HISTORY = 100;

// localStorage keys holding one signed-in user's private data. Cleared on
// sign-out and when a different user signs in, so a shared browser never leaks
// one person's saved restaurants, profile, or sync credential to the next.
const USER_SCOPED_KEYS = [PROFILE_KEY, SAVED_KEY, SYNC_SESSION_KEY];

/** Wipe the current user's private data from this device. */
export function clearLocalUserData(): void {
  for (const key of USER_SCOPED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore storage access errors — nothing to clear if it is unavailable
    }
  }
}

/**
 * True when `email` is a different account than the one whose data is currently
 * on this device. Callers clear local data before restoring so the new user
 * never inherits the previous user's saves when their own cloud copy is empty.
 */
export async function isDifferentUser(email: string): Promise<boolean> {
  const current = await loadProfile();
  const prev = (current.email ?? '').trim().toLowerCase();
  const next = email.trim().toLowerCase();
  return prev !== '' && prev !== next;
}

export function menuStats(menu: ParsedMenu): { categoryCount: number; itemCount: number } {
  const categoryCount = Array.isArray(menu.categories) ? menu.categories.length : 0;
  const itemCount = Array.isArray(menu.categories)
    ? menu.categories.reduce((sum, category) => sum + (Array.isArray(category.items) ? category.items.length : 0), 0)
    : 0;
  return { categoryCount, itemCount };
}

function normalizeProfile(profile: Partial<UserProfile> | null | undefined): UserProfile {
  const merged = { ...EMPTY_PROFILE, ...(profile ?? {}) };
  return {
    ...merged,
    diningHistory: Array.isArray(merged.diningHistory)
      ? merged.diningHistory.slice(0, MAX_DINING_HISTORY)
      : [],
  };
}

function normalizeSavedRestaurant(r: SavedRestaurant): SavedRestaurant {
  const stats = menuStats(r.menu);
  const capturedAt = r.capturedAt || new Date().toISOString();
  return {
    ...r,
    capturedAt,
    createdAt: r.createdAt ?? capturedAt,
    updatedAt: r.updatedAt ?? capturedAt,
    openCount: r.openCount ?? 0,
    saveCount: r.saveCount ?? 1,
    categoryCount: r.categoryCount ?? stats.categoryCount,
    itemCount: r.itemCount ?? stats.itemCount,
  };
}

function normalizeSavedRestaurants(restaurants: unknown): SavedRestaurant[] {
  return Array.isArray(restaurants)
    ? restaurants.map((r) => normalizeSavedRestaurant(r as SavedRestaurant))
    : [];
}

// ── Cloud sync ────────────────────────────────────────────────────────────────
// Bug #20: /api/sync now requires a verified session token — see server/auth.ts.
// Email-only login has no such credential and stays local-only by design;
// Google sign-in exchanges its ID token for one via establishSyncSession().

interface SyncSession { token: string; email: string; }

function readSyncSession(): SyncSession | null {
  try {
    const raw = localStorage.getItem(SYNC_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.token === 'string' && typeof parsed.email === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSyncSession(session: SyncSession | null): void {
  try {
    if (session) localStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SYNC_SESSION_KEY);
  } catch {
    // ignore storage access errors
  }
}

/**
 * Exchange a fresh Google ID token for a Meet My Menu AI sync session. Call once
 * right after Google Sign-In succeeds. Returns the server-verified email on
 * success (the authoritative identity for sync going forward), or null if the
 * exchange failed — callers should still let sign-in proceed locally in that
 * case; cloud sync just stays unavailable until the next successful exchange.
 */
export async function establishSyncSession(idToken: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl('/api/sync?action=session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.sessionToken || typeof data.email !== 'string') return null;
    const email = data.email.trim().toLowerCase();
    writeSyncSession({ token: data.sessionToken, email });
    return email;
  } catch {
    return null;
  }
}

/** The Bearer header for `forEmail`'s sync session, or null when there is
 * none — no session at all (email-only login), or a stale session left over
 * from a different account. Callers must silently skip cloud sync when null. */
function syncAuthHeader(forEmail: string): Record<string, string> | null {
  const session = readSyncSession();
  if (!session || session.email !== forEmail.trim().toLowerCase()) return null;
  return { Authorization: `Bearer ${session.token}` };
}

async function pushToCloud(profile: UserProfile, restaurants: SavedRestaurant[]) {
  if (!profile.email) return;
  const authHeader = syncAuthHeader(profile.email);
  if (!authHeader) return; // no verified session for this account — stay local-only
  try {
    const body = JSON.stringify({ profile, restaurants });
    const res = await fetch(apiUrl('/api/sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body,
    });
    if (res.status === 401) writeSyncSession(null); // stale/expired — stop resending it
    track('sync', 'push', {
      outcome: res.ok ? 'success' : 'failure',
      metadata: { bytes: body.length, restaurant_count: restaurants.length },
    });
  } catch {
    track('sync', 'push', { outcome: 'failure' });
    // offline — local save already happened, cloud will be stale until next push
  }
}

export async function loadFromCloud(email: string): Promise<{ profile: UserProfile; restaurants: SavedRestaurant[] } | null> {
  const authHeader = syncAuthHeader(email);
  if (!authHeader) return null; // no verified session for this account — nothing to pull
  try {
    const res = await fetch(apiUrl('/api/sync'), { headers: authHeader });
    if (res.status === 401) writeSyncSession(null);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data) return null;
    track('sync', 'pull', {
      outcome: 'success',
      metadata: { restaurant_count: (data.restaurants ?? []).length },
    });
    return { profile: normalizeProfile(data.profile), restaurants: normalizeSavedRestaurants(data.restaurants) };
  } catch {
    return null;
  }
}

// Writes cloud data into localStorage so the rest of the app picks it up normally.
export async function restoreFromCloud(email: string): Promise<UserProfile | null> {
  const cloud = await loadFromCloud(email);
  if (!cloud?.profile) return null;
  const merged: UserProfile = normalizeProfile({ ...cloud.profile, email });
  localStorage.setItem(PROFILE_KEY, JSON.stringify(merged));
  localStorage.setItem(SAVED_KEY, JSON.stringify(normalizeSavedRestaurants(cloud.restaurants)));
  return merged;
}

export async function loadProfile(): Promise<UserProfile> {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return { ...EMPTY_PROFILE };
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  const normalized = normalizeProfile(profile);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(normalized));
  const restaurants = await loadSavedRestaurants();
  pushToCloud(normalized, restaurants);
}

export async function loadSavedRestaurants(): Promise<SavedRestaurant[]> {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    return normalizeSavedRestaurants(JSON.parse(raw));
  } catch {
    return [];
  }
}

function trySetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e: any) {
    const isQuota = e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014;
    if (!isQuota) throw e;
    track('error', 'storage_quota', { metadata: { key } });
    // Storage full — drop oldest saved restaurants one at a time until it fits.
    try {
      let trimmed = JSON.parse(value) as SavedRestaurant[];
      while (trimmed.length > 1) {
        trimmed = trimmed.slice(0, -1);
        try {
          localStorage.setItem(key, JSON.stringify(trimmed));
          return;
        } catch {}
      }
    } catch {}
    throw new Error('Storage is full. Delete some saved restaurants to free up space.');
  }
}

export interface SaveRestaurantOptions {
  sourceUrl?: string;
  location?: string; // confirmed branch address — keeps chain branches separate
  provenance?: MenuProvenance;
}

// Identity key for de-duplication. A chain has many branches, so we key on the
// restaurant name AND its location: "Cheesecake Factory" in Paramus and in
// Freehold are DIFFERENT saved entries and must not overwrite each other. Only a
// re-save of the SAME name at the SAME location (or both with no location)
// replaces the previous one — that is a refresh, not a new place.
function locationKey(r: { name: string; location?: string; provenance?: MenuProvenance }): string {
  const loc = (r.location ?? r.provenance?.confirmedLocation ?? '').trim().toLowerCase();
  return `${r.name.trim().toLowerCase()}|${loc}`;
}

export async function saveRestaurant(
  name: string,
  menu: ParsedMenu,
  opts: SaveRestaurantOptions = {},
): Promise<SavedRestaurant> {
  const { sourceUrl, location, provenance } = opts;
  const list = await loadSavedRestaurants();
  const now = new Date().toISOString();
  const stats = menuStats(menu);
  const entryKey = locationKey({
    name: name.trim() || 'Unnamed restaurant',
    location,
    provenance,
  });
  const existing = list.find((r) => locationKey(r) === entryKey);
  const entry: SavedRestaurant = {
    id: existing?.id ?? `r-${Date.now()}`,
    name: name.trim() || 'Unnamed restaurant',
    menu,
    capturedAt: now,
    createdAt: existing?.createdAt ?? existing?.capturedAt ?? now,
    updatedAt: now,
    lastOpenedAt: existing?.lastOpenedAt,
    openCount: existing?.openCount ?? 0,
    saveCount: (existing?.saveCount ?? 0) + 1,
    categoryCount: stats.categoryCount,
    itemCount: stats.itemCount,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(location ? { location } : {}),
    ...(provenance ? { provenance } : {}),
  };
  const filtered = list.filter((r) => locationKey(r) !== entryKey);
  filtered.unshift(entry);
  trySetItem(SAVED_KEY, JSON.stringify(filtered));
  track('restaurant', 'saved', {
    content: { id: entry.id, name: entry.name },
    metadata: {
      location: entry.location,
      sourceType: provenance?.sourceType,
      category_count: entry.categoryCount,
      item_count: entry.itemCount,
      save_count: entry.saveCount,
    },
  });
  const profile = await loadProfile();
  pushToCloud(profile, filtered);
  return entry;
}

export async function markRestaurantOpened(id: string): Promise<SavedRestaurant | null> {
  const list = await loadSavedRestaurants();
  const index = list.findIndex((r) => r.id === id);
  if (index < 0) return null;

  const now = new Date().toISOString();
  const updated: SavedRestaurant = {
    ...list[index],
    lastOpenedAt: now,
    openCount: (list[index].openCount ?? 0) + 1,
    updatedAt: now,
  };
  const next = [...list];
  next[index] = updated;
  localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  track('saved', 'open', {
    content: { restaurantName: updated.name },
    metadata: {
      location: updated.location,
      sourceType: updated.provenance?.sourceType,
      item_count: updated.itemCount,
      open_count: updated.openCount,
      last_opened_at: updated.lastOpenedAt,
    },
  });
  const profile = await loadProfile();
  pushToCloud(profile, next);
  return updated;
}

export async function deleteRestaurant(id: string): Promise<void> {
  const list = await loadSavedRestaurants();
  const updated = list.filter((r) => r.id !== id);
  localStorage.setItem(SAVED_KEY, JSON.stringify(updated));
  track('restaurant', 'deleted', { content: { id } });
  const profile = await loadProfile();
  pushToCloud(profile, updated);
}
