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
import { createRateLimiters, mountRateLimiters } from '../middleware/rateLimit';

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

/**
 * Mounted by the same function index.ts calls. Route stand-ins answer with the status in
 * `x-status` (default 200), so a test can play a correct password (200) or a wrong one (401).
 */
function buildApp() {
  const redis = fakeRedis();
  const app = express();
  mountRateLimiters(app, createRateLimiters(redis.send));
  const answer = (req: express.Request, res: express.Response) =>
    res.status(Number(req.header('x-status') ?? 200)).json({ success: true });
  app.post('/api/auth/login', answer);
  app.post('/api/auth/forgot-password', answer);
  app.get('/api/schools/x/dashboard', answer);
  return { app, redis };
}

const login = (app: express.Express, status = 200) =>
  request(app).post('/api/auth/login').set('x-status', String(status));

describe('auth and general limiters on one Redis', () => {
  it('browsing the app does not use up the login allowance', async () => {
    const { app } = buildApp();
    expect((await login(app)).status).toBe(200);
    // What the principal did between logins: dashboard, settings screen, a save.
    for (let i = 0; i < 7; i++) {
      expect((await request(app).get('/api/schools/x/dashboard')).status).toBe(200);
    }
    expect((await login(app)).status).toBe(200);
  });

  it('keeps each limiter under its own Redis key', async () => {
    const { app, redis } = buildApp();
    await request(app).post('/api/auth/forgot-password');
    // One key per limiter for this client — two, not one shared.
    expect(redis.keys.size).toBe(2);
  });
});

describe('the login limiter counts guesses, not logins', () => {
  // Production, 28 Sep 15:57:45–15:58:25: five correct passwords in 35 seconds, the sixth
  // refused in 28 ms before the password was checked. Six teachers on one staff-room router.
  it('a correct password is never spent against the allowance', async () => {
    const { app } = buildApp();
    for (let i = 0; i < 30; i++) expect((await login(app)).status).toBe(200);
  });

  it('wrong passwords are: the 6th attempt in a minute is refused before it is checked', async () => {
    const { app } = buildApp();
    for (let i = 0; i < 5; i++) expect((await login(app, 401)).status).toBe(401);
    const blocked = await login(app, 401);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('once refused, a correct password from the same address is refused too', async () => {
    const { app } = buildApp();
    for (let i = 0; i < 5; i++) await login(app, 401);
    expect((await login(app, 200)).status).toBe(429);
  });
});

describe('the other auth routes keep counting every request', () => {
  // forgot-password answers 200 whether or not the account exists, so as not to reveal
  // which emails are registered. Counting only failures would never count it at all,
  // and it sends email.
  it('the 6th forgot-password request in a minute is refused, though all five "succeeded"', async () => {
    const { app } = buildApp();
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/auth/forgot-password')).status).toBe(200);
    expect((await request(app).post('/api/auth/forgot-password')).status).toBe(429);
  });

  it('logins and forgot-password do not share an allowance', async () => {
    const { app } = buildApp();
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/forgot-password');
    expect((await login(app)).status).toBe(200);
  });
});
