import { useSyncExternalStore } from 'react';

/**
 * Tiny localStorage-backed store for per-device conveniences (recent searches, recently viewed,
 * remembered PIN code). Storage can be unavailable (private mode, blocked), so every access is
 * guarded and the UI must work without it.
 */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore: storage full or blocked
  }
}

export function createLocalStore<T>(key: string, fallback: T) {
  const listeners = new Set<() => void>();
  let cache: T | undefined;

  const get = () => (cache ??= read(key, fallback));
  const set = (next: T | ((prev: T) => T)) => {
    cache = typeof next === 'function' ? (next as (prev: T) => T)(get()) : next;
    write(key, cache);
    listeners.forEach((l) => l());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    // Keep tabs in sync.
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        cache = undefined;
        listener();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  };
  const useValue = () => useSyncExternalStore(subscribe, get, () => fallback);
  return { get, set, useValue };
}

export const recentSearches = createLocalStore<string[]>('avero:recent-searches', []);

export function rememberSearch(q: string): void {
  const query = q.trim();
  if (!query) return;
  recentSearches.set((prev) => [query, ...prev.filter((p) => p.toLowerCase() !== query.toLowerCase())].slice(0, 6));
}

export interface RecentlyViewedEntry {
  colorwayId: string;
  href: string;
  name: string;
  colorName: string;
  pricePaise: number;
  image: { url: string; thumbUrl: string | null; alt: string } | null;
  viewedAt: number;
}

export const recentlyViewed = createLocalStore<RecentlyViewedEntry[]>('avero:recently-viewed', []);

export function rememberView(entry: Omit<RecentlyViewedEntry, 'viewedAt'>): void {
  recentlyViewed.set((prev) =>
    [{ ...entry, viewedAt: Date.now() }, ...prev.filter((p) => p.colorwayId !== entry.colorwayId)].slice(0, 20),
  );
}

export const savedPincode = createLocalStore<string | null>('avero:pincode', null);
