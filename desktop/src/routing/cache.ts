/**
 * Generic LRU cache with TTL-based expiration. Ported from routing/cache.go.
 *
 * Expiry is lazy (checked on get, like Go) — there is no sweep timer here, so
 * requirement 5 ("any timer must be unref'd") does not apply to this file.
 */

import { createHash } from 'node:crypto';

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class LRUCache<V> {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly items = new Map<string, CacheEntry<V>>();

  constructor(capacity: number, ttlMs: number) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  get(key: string): { value: V | undefined; ok: boolean } {
    const entry = this.items.get(key);
    if (!entry) return { value: undefined, ok: false };

    if (Date.now() > entry.expiresAt) {
      this.items.delete(key);
      return { value: undefined, ok: false };
    }

    // Map iteration order is insertion order, so re-inserting moves this key
    // to the most-recently-used end — the same effect as Go's list.MoveToFront.
    this.items.delete(key);
    this.items.set(key, entry);
    return { value: entry.value, ok: true };
  }

  put(key: string, value: V): void {
    if (this.items.has(key)) {
      this.items.delete(key);
      this.items.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      return;
    }

    if (this.items.size >= this.capacity) {
      // Map.keys() yields oldest-first (insertion order), the least recently used.
      const oldest = this.items.keys().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }

    this.items.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

export function hashKey(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
