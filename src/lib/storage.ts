// Local persistence with localStorage + cloud sync via /api/sync.
// SavedRestaurant carries its own id + capturedAt so a future V2 "shared menus
// across users" feature needs no migration.

import { UserProfile, EMPTY_PROFILE, SavedRestaurant, ParsedMenu } from '../types';
import { track } from './telemetry';

const PROFILE_KEY = 'menuvoice.profile.v1';
const SAVED_KEY = 'menuvoice.savedRestaurants.v1';

// ── Cloud sync ────────────────────────────────────────────────────────────────

async function pushToCloud(profile: UserProfile, restaurants: SavedRestaurant[]) {
  if (!profile.email) return;
  try {
    const body = JSON.stringify({ email: profile.email, profile, restaurants });
    await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    track('sync', 'push', {
      outcome: 'success',
      metadata: { bytes: body.length, restaurant_count: restaurants.length },
    });
  } catch {
    track('sync', 'push', { outcome: 'failure' });
    // offline — local save already happened, cloud will be stale until next push
  }
}

export async function loadFromCloud(email: string): Promise<{ profile: UserProfile; restaurants: SavedRestaurant[] } | null> {
  try {
    const res = await fetch(`/api/sync?email=${encodeURIComponent(email)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data) return null;
    track('sync', 'pull', {
      outcome: 'success',
      metadata: { restaurant_count: (data.restaurants ?? []).length },
    });
    return { profile: data.profile ?? null, restaurants: data.restaurants ?? [] };
  } catch {
    return null;
  }
}

// Writes cloud data into localStorage so the rest of the app picks it up normally.
export async function restoreFromCloud(email: string): Promise<UserProfile | null> {
  const cloud = await loadFromCloud(email);
  if (!cloud?.profile) return null;
  const merged: UserProfile = { ...EMPTY_PROFILE, ...cloud.profile, email };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(merged));
  localStorage.setItem(SAVED_KEY, JSON.stringify(cloud.restaurants ?? []));
  return merged;
}

export async function loadProfile(): Promise<UserProfile> {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return { ...EMPTY_PROFILE };
    return { ...EMPTY_PROFILE, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  const restaurants = await loadSavedRestaurants();
  pushToCloud(profile, restaurants);
}

export async function loadSavedRestaurants(): Promise<SavedRestaurant[]> {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
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

export async function saveRestaurant(name: string, menu: ParsedMenu, sourceUrl?: string): Promise<SavedRestaurant> {
  const list = await loadSavedRestaurants();
  const entry: SavedRestaurant = {
    id: `r-${Date.now()}`,
    name: name.trim() || 'Unnamed restaurant',
    menu,
    capturedAt: new Date().toISOString(),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
  const filtered = list.filter((r) => r.name.toLowerCase() !== entry.name.toLowerCase());
  filtered.unshift(entry);
  trySetItem(SAVED_KEY, JSON.stringify(filtered));
  track('restaurant', 'saved', { content: { id: entry.id, name: entry.name } });
  const profile = await loadProfile();
  pushToCloud(profile, filtered);
  return entry;
}

export async function deleteRestaurant(id: string): Promise<void> {
  const list = await loadSavedRestaurants();
  const updated = list.filter((r) => r.id !== id);
  localStorage.setItem(SAVED_KEY, JSON.stringify(updated));
  track('restaurant', 'deleted', { content: { id } });
  const profile = await loadProfile();
  pushToCloud(profile, updated);
}
