/**
 * The limiters as production runs them: both backed by ONE Redis.
 *
 * Both limiters used rate-limit-redis's default key prefix, and both key by client IP, so
 * they read and wrote the same Redis counter. Every request anywhere under /api counted
 * against the login allowance of 5 per minute: a principal who logged in, opened the
 * dashboard (four requests) and saved a setting was refused on their next login with
 * "Too many requests" — in 32 ms, before the password was ever checked. Found in
 * production on 28 Sep 2026.
 *
 * rateLimit.test.ts could not see it: without REDIS_URL each limiter gets its own
 * in-process MemoryStore, so the collision only exists on the Redis path. This file
 * drives that path with a fake Redis shared between the two stores, exactly as the one
 * real Redis instance is shared in production.
 */
import request from 'supertest';
import express from 'express';
import type { RedisReply } from 'rate-limit-redis';
import { createRateLimiters } from '../middleware/rateLimit';

/**
 * Just enough Redis for rate-limit-redis: SCRIPT LOAD, and EVALSHA of its two scripts
 * (increment, get) with the semantics of their Lua bodies, plus DECR and DEL.
 */
function fakeRedis() {
  const keys = new Map<string, { hits: number; expiresAt: number }>();
  const scripts = new Map<string, string>();
  const live = (k: string) => {
    const e = keys.get(k);
    if (e && e.expiresAt <= Date.now()) keys.delete(k);
    return keys.get(k);
  };
  const send = async (...args: string[]): Promise<RedisReply> => {
    const [cmd, ...rest] = args;
    switch (cmd.toUpperCase()) {
      case 'SCRIPT': {
        const sha = `sha${scripts.size}`;
        scripts.set(sha, rest[1]);
        return sha;
      }
      case 'EVALSHA': {
        const [sha, , key, ...argv] = rest;
        const body = scripts.get(sha) ?? '';
        const e = live(key);
        if (body.includes('INCR')) {
          const windowMs = Number(argv[1]);
          if (!e) {
            keys.set(key, { hits: 1, expiresAt: Date.now() + windowMs });
            return [1, windowMs];
          }
          e.hits += 1;
          return [e.hits, e.expiresAt - Date.now()];
        }
        return e ? [String(e.hits), e.expiresAt - Date.now()] : [false as unknown as string, -2];
      }
      case 'DECR': { const e = live(rest[0]); if (e) e.hits -= 1; return e?.hits ?? 0; }
      case 'DEL': keys.delete(rest[0]); return 1;
      default: throw new Error(`fake redis: unsupported ${cmd}`);
    }
  };
  return { send, keys };
}

/** Mounted exactly as index.ts mounts them. */
function buildApp() {
  const redis = fakeRedis();
  const { general, auth } = createRateLimiters(redis.send);
  const app = express();
  app.use('/api/auth', auth);
  app.use('/api', general);
  app.post('/api/auth/login', (_req, res) => res.json({ success: true }));
  app.get('/api/schools/x/dashboard', (_req, res) => res.json({ success: true }));
  return { app, redis };
}

describe('auth and general limiters on one Redis', () => {
  it('browsing the app does not use up the login allowance', async () => {
    const { app } = buildApp();
    expect((await request(app).post('/api/auth/login')).status).toBe(200);
    // What the principal did between logins: dashboard, settings screen, a save.
    for (let i = 0; i < 7; i++) {
      expect((await request(app).get('/api/schools/x/dashboard')).status).toBe(200);
    }
    expect((await request(app).post('/api/auth/login')).status).toBe(200);
  });

  it('still refuses the 6th auth request in a minute — the separation did not remove the limit', async () => {
    const { app } = buildApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/auth/login')).status).toBe(200);
    const blocked = await request(app).post('/api/auth/login');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('keeps the two counters under distinct Redis keys', async () => {
    const { app, redis } = buildApp();
    await request(app).post('/api/auth/login');
    // One key per limiter for this client — two, not one shared.
    expect(redis.keys.size).toBe(2);
  });
});
