// src/logs/aggregateCache.ts
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 200;
const MAX_ENTRIES = 100;
const cache = new Map<string, CacheEntry>();

export function getCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCached(key: string, value: unknown): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}