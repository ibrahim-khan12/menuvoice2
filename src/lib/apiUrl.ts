import { Capacitor } from '@capacitor/core';

const NATIVE_API_ORIGIN = 'https://app.meetmymenu.com';

/**
 * Capacitor serves bundled files from capacitor://localhost. Relative /api
 * requests therefore hit the local asset server instead of Vercel. Native
 * builds must call the same production backend used by the web app.
 */
export function apiUrl(path: string, native = Capacitor.isNativePlatform()): string {
  return native
    ? new URL(path, NATIVE_API_ORIGIN).toString()
    : path;
}
