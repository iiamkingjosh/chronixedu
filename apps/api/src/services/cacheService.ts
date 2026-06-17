import NodeCache from 'node-cache';

const TTL = {
  SCHOOL:   5 * 60,  // 5 min  — school identity/settings (changes rarely)
  ROSTER:   3 * 60,  // 3 min  — classes, subjects, staff lists
  CONTEXT:  60,      // 1 min  — active session/term
  STATS:    5 * 60,  // 5 min  — dashboard stats
} as const;

const store = new NodeCache({ stdTTL: TTL.SCHOOL, checkperiod: 60, useClones: false });

export const cache = {
  get<T>(key: string): T | undefined {
    return store.get<T>(key);
  },

  set<T>(key: string, value: T, ttl: number): void {
    store.set(key, value, ttl);
  },

  del(...keys: string[]): void {
    store.del(keys);
  },

  delByPrefix(prefix: string): void {
    const keys = store.keys().filter(k => k.startsWith(prefix));
    if (keys.length) store.del(keys);
  },

  async wrap<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = store.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    store.set(key, value, ttl);
    return value;
  },

  TTL,
};

export function schoolCacheKey(schoolId: string, suffix: string): string {
  return `school:${schoolId}:${suffix}`;
}
