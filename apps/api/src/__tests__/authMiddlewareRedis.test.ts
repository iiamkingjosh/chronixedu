/**
 * Every authenticated request reads Redis in verifyToken (token blacklist, user_active
 * cache) and requirePasswordChanged (must_change_password cache), inside a try/catch that
 * answered 503. So with the limiters and the login lockout failing open, a Redis outage
 * still took down every authenticated request. Now Redis is best-effort there too: a
 * failure is a cache miss answered by the database, and it is logged.
 *
 * Doctrine 16: "200 with Redis down" is also what a middleware that never used Redis
 * produces — so the first test proves the cache is in use, and the last proves the
 * database still decides (a suspended user is refused either way).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../config/logger';

process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

jest.mock('../config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockLogger = logger as jest.Mocked<typeof logger>;

let broken = false;
const down = () => { if (broken) throw new Error('fake redis: connection refused'); };
const cache = new Map<string, string>();
jest.mock('../middleware/rateLimit', () => ({
  ...jest.requireActual('../middleware/rateLimit'),
  redis: {
    get: async (k: string) => { down(); return cache.get(k) ?? null; },
    set: async (k: string, v: string) => { down(); cache.set(k, v); return 'OK'; },
  },
}));

let active = true;
const dbQueries: string[] = [];
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: async (sql: string) => { dbQueries.push(sql); return { rows: [{ is_active: active, must_change_password: false }] }; },
    connect: jest.fn(), end: jest.fn(), on: jest.fn(),
  })),
  Client: jest.fn(),
}));

import { verifyToken, requirePasswordChanged } from '../middleware/auth';

const app = express();
app.get('/x', verifyToken, requirePasswordChanged, (_req, res) => res.json({ success: true }));
const token = jwt.sign({ user_id: 'u1', role: 'teacher', school_id: 's1', email: 'a@b.c' }, 'test-secret', { expiresIn: '1h' });
const call = () => request(app).get('/x').set('Authorization', `Bearer ${token}`);

beforeEach(() => { broken = false; active = true; cache.clear(); dbQueries.length = 0; jest.clearAllMocks(); });

describe('authenticated requests when Redis is unavailable', () => {
  it('the cache is in use while Redis works: a second request asks the database nothing', async () => {
    expect((await call()).status).toBe(200);
    const asked = dbQueries.length;
    expect(asked).toBeGreaterThan(0);
    expect((await call()).status).toBe(200);
    expect(dbQueries.length).toBe(asked);
  });

  it('with every Redis command throwing, the request is answered from the database, not refused with 503 — logged', async () => {
    broken = true;
    const res = await call();
    expect(res.status).toBe(200);
    expect(dbQueries.some(q => /is_active/.test(q))).toBe(true);
    expect(dbQueries.some(q => /must_change_password/.test(q))).toBe(true);
    for (const event of ['token_blacklist_unavailable', 'user_active_cache_unavailable', 'must_change_password_cache_unavailable']) {
      expect(mockLogger.error).toHaveBeenCalledWith(event, expect.objectContaining({ error: expect.any(String) }));
    }
  });

  it('a suspended user is still refused with Redis down — the database decides, the cache only remembers', async () => {
    broken = true;
    active = false;
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});
