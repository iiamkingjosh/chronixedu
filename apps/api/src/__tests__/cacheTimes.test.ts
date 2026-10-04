/**
 * The cache times that decide whether a request is let in have one home, config/cacheTimes.json,
 * which the deletion script also reads to wait them out (4 Oct 2026, docs/AUDIT-2026-09.md fix (a2)).
 * Before it, the same 300 was typed seven times for two Redis keys, and two careful reviewers each
 * miscounted the copies. This fails on copy eight.
 */
import fs from 'fs';
import path from 'path';
import config from '../config/cacheTimes.json';
import { SCHOOL_CACHE_SECONDS, USER_ACTIVE_CACHE_SECONDS, MUST_CHANGE_PASSWORD_CACHE_SECONDS } from '../config/cacheTimes';
import { cache } from '../services/cacheService';

const SRC = path.join(__dirname, '..');

/** A Redis expiry given as a number: `'EX', 300` or `'EX', 30 * 60`. */
const LITERAL_EXPIRY = /['"]EX['"]\s*,\s*\(?\s*\d/;

/**
 * The places that may still type a number, each with its reason. Neither is one of the caches the
 * deletion wait covers.
 */
const LITERAL_EXPIRY_ALLOWED: Array<{ file: string; contains: string; why: string }> = [
  { file: 'routes/sessions.ts', contains: "ctx_cache_unavailable", why: 'The current session/term context, a plain one-minute cache; it lets no request in.' },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['__tests__', '__db_tests__'].includes(e.name)) sourceFiles(full, out); continue; }
    if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function literalExpiries(): Array<{ file: string; line: string }> {
  const found: Array<{ file: string; line: string }> = [];
  for (const full of sourceFiles(SRC)) {
    const file = path.relative(SRC, full).split(path.sep).join('/');
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      if (LITERAL_EXPIRY.test(line)) found.push({ file, line: line.trim() });
    }
  }
  return found;
}

describe('the cache times have one home', () => {
  it('control: the pattern catches a typed-in expiry, and not one read from the file', () => {
    expect(LITERAL_EXPIRY.test("await redis.set(`user_active:${id}`, '0', 'EX', 300);")).toBe(true);
    expect(LITERAL_EXPIRY.test("await redis.set(k, '1', 'EX', 30 * 60);")).toBe(true);
    expect(LITERAL_EXPIRY.test("r.set(cacheKey, value, 'EX', USER_ACTIVE_CACHE_SECONDS)")).toBe(false);
  });

  it('no Redis expiry in src is a typed-in number, except the listed ones', () => {
    const offenders = literalExpiries().filter(
      (f) => !LITERAL_EXPIRY_ALLOWED.some((a) => a.file === f.file && f.line.includes(a.contains)));
    expect(offenders).toEqual([]);
  });

  it('every allowed exception still exists, so the list cannot go stale', () => {
    const found = literalExpiries();
    for (const a of LITERAL_EXPIRY_ALLOWED) {
      expect({ a: a.file, present: found.some((f) => f.file === a.file && f.line.includes(a.contains)) })
        .toEqual({ a: a.file, present: true });
    }
  });

  it('the TypeScript reads the file and restates nothing', () => {
    expect(SCHOOL_CACHE_SECONDS).toBe(config.school_seconds);
    expect(USER_ACTIVE_CACHE_SECONDS).toBe(config.user_active_seconds);
    expect(MUST_CHANGE_PASSWORD_CACHE_SECONDS).toBe(config.must_change_password_seconds);
    expect(cache.TTL.SCHOOL).toBe(config.school_seconds);
    const source = fs.readFileSync(path.join(SRC, 'config', 'cacheTimes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/=\s*\d/);
  });

  it('the deletion script waits out the longest of them, from the same file', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deletionWaitSeconds, WAIT_MARGIN_SECONDS } = require('../../scripts/delete-school-data.js');
    const longest = Math.max(...Object.entries(config).filter(([k]) => k.endsWith('_seconds')).map(([, v]) => v as number));
    expect(deletionWaitSeconds()).toBe(longest + WAIT_MARGIN_SECONDS);
    expect(longest).toBeGreaterThanOrEqual(300);
  });
});
