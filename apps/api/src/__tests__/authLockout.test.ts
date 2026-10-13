/**
 * The per-email lockout in POST /login is the control against guessing one account.
 * It is what makes the per-address limiter safe to keep loose (docs/rate-limit-
 * remediation.md, test 5) — and it had no test at all: auth.test.ts runs with `redis`
 * null, which is the "no lockout in dev" branch.
 *
 * The property: five wrong passwords for one email, each from a DIFFERENT address, then
 * the CORRECT password from a sixth address — refused with ACCOUNT_LOCKED. The password
 * is never even sent to Supabase. Spreading the attempts over addresses is the point:
 * nothing keyed on the address can be what stopped it.
 */
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/errorHandler';
import { logger } from '../config/logger';

jest.mock('../config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockLogger = logger as jest.Mocked<typeof logger>;

process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

const mockSignIn = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: (...a: unknown[]) => mockSignIn(...a) } },
  supabaseAdmin: { auth: { admin: {} } },
}));
/** What the login connection answers: the local user row, the school (active, SECURITY.md Round 42), the last_login stamp, the tier. */
const mockQuery = jest.fn(async (sql: string) => {
  if (/FROM users/.test(sql)) return { rows: [{ id: 'local-1', school_id: 'school-1', role: 'teacher', title: null, email: 'target@school.ng', first_name: 'T', last_name: 'A', is_active: true, support_code: '000000', must_change_password: false }] };
  if (/FROM schools/.test(sql)) return { rows: [{ subscription_tier: 'premium', is_active: true }] };
  return { rows: [] };
});
jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: (...a: unknown[]) => mockQuery(...(a as [string])), end: jest.fn() })),
  Pool: jest.fn().mockImplementation(() => ({ query: jest.fn(), connect: jest.fn(), end: jest.fn(), on: jest.fn() })),
}));
jest.mock('../db/queries/users');
jest.mock('../db/queries/auditLog');

/**
 * The ioredis commands the lockout uses, over plain maps. A key's remaining life is whatever `expire`
 * last set, and a test moves time on by setting it lower.
 * `broken` makes every command throw, as a dead Redis does once its command timeout fires;
 * `ttlBroken` makes only the expiry read throw.
 */
const store = new Map<string, number>();
const ttls = new Map<string, number>();
let broken = false;
let ttlBroken = false;
const down = () => { if (broken) throw new Error('fake redis: connection refused'); };
jest.mock('../middleware/rateLimit', () => ({
  ...jest.requireActual('../middleware/rateLimit'),
  redis: {
    get: async (k: string) => { down(); return store.has(k) ? String(store.get(k)) : null; },
    incr: async (k: string) => { down(); const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
    expire: async (k: string, seconds: number) => { down(); ttls.set(k, seconds); return 1; },
    ttl: async (k: string) => {
      down();
      if (ttlBroken) throw new Error('fake redis: ttl timed out');
      return store.has(k) ? (ttls.get(k) ?? -1) : -2;
    },
    del: async (k: string) => { down(); store.delete(k); ttls.delete(k); return 1; },
  },
}));

import authRouter from '../routes/auth';

const app = express();
app.set('trust proxy', true); // so X-Forwarded-For chooses req.ip, as Railway's edge does
app.use(express.json());
app.use('/api/auth', authRouter);
app.use(errorHandler);

const attempt = (ip: string, password: string) =>
  request(app).post('/api/auth/login').set('X-Forwarded-For', ip)
    .send({ email: 'Target@School.ng', password });

beforeEach(() => { store.clear(); ttls.clear(); broken = false; ttlBroken = false; mockSignIn.mockReset(); jest.clearAllMocks(); });

describe('per-email lockout', () => {
  it('five wrong passwords from five addresses lock the account; the right password from a sixth is refused unchecked', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    const results = [];
    for (let i = 1; i <= 5; i++) results.push((await attempt(`203.0.113.${i}`, 'wrong')).body.error.code);
    // The 5th failure is what trips it (emailAttempts >= MAX_ATTEMPTS), not the 6th request.
    expect(results).toEqual(['INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED']);
    expect(mockSignIn).toHaveBeenCalledTimes(5);

    mockSignIn.mockResolvedValue({ data: { user: { id: 'auth-uuid' } }, error: null });
    const sixth = await attempt('203.0.113.6', 'correct-password');
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(mockSignIn).toHaveBeenCalledTimes(5); // the correct password was never sent
  });

  it('is keyed on the email case-insensitively — TARGET@ and target@ are one account', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    for (let i = 1; i <= 4; i++) await attempt(`203.0.113.${i}`, 'wrong');
    const fifth = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9')
      .send({ email: 'TARGET@SCHOOL.NG', password: 'wrong' });
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('four wrong passwords do not lock it — the fifth attempt with the right password is checked', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    for (let i = 1; i <= 4; i++) await attempt(`203.0.113.${i}`, 'wrong');
    mockSignIn.mockResolvedValue({ data: { user: { id: 'auth-uuid' } }, error: null });
    await attempt('203.0.113.5', 'correct-password');
    expect(mockSignIn).toHaveBeenCalledTimes(5); // the fifth call reached Supabase
    expect(mockSignIn.mock.calls[4][0]).toEqual({ email: 'target@school.ng', password: 'correct-password' }); // zod lowercases it
  });
});

describe('a lock says how long is left (8 Oct 2026)', () => {
  // The window runs from the FIRST failure, so "Try again in 15 minutes" was wrong after the first
  // second. The refusal now carries the counter's own remaining life: in the message, in
  // retry_after_seconds for the sign-in page's countdown, and in Retry-After.
  it('the locking attempt, and every one after it, carries the time the lock has left', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    for (let i = 1; i <= 4; i++) await attempt(`203.0.113.${i}`, 'wrong');
    const fifth = await attempt('203.0.113.5', 'wrong');
    expect(fifth.status).toBe(429);
    expect(fifth.headers['retry-after']).toBe('900');
    expect(fifth.body.error).toEqual({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.', retry_after_seconds: 900 });

    ttls.set('login_attempts:target@school.ng', 541); // nine minutes and a second later
    const later = await attempt('203.0.113.6', 'right');
    expect(later.headers['retry-after']).toBe('541');
    expect(later.body.error).toEqual({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 10 minutes.', retry_after_seconds: 541 });

    ttls.set('login_attempts:target@school.ng', 59);
    expect((await attempt('203.0.113.6', 'right')).body.error.message).toBe('Too many failed attempts. Try again in 1 minute.');
  });

  it('a network locked by 20 failures says when the network\'s lock lifts', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    for (let i = 1; i <= 20; i++) {
      await request(app).post('/api/auth/login').set('X-Real-IP', '198.51.100.7').send({ email: `person${i}@school.ng`, password: 'wrong' });
    }
    ttls.set('login_attempts_ip:198.51.100.7', 300);
    const res = await request(app).post('/api/auth/login').set('X-Real-IP', '198.51.100.7').send({ email: 'someone.else@school.ng', password: 'right' });
    expect(res.status).toBe(429);
    expect(res.body.error.retry_after_seconds).toBe(300);
  });

  it('locked both ways, it waits for the later of the two, since both must lift', async () => {
    store.set('login_attempts:target@school.ng', 5);
    ttls.set('login_attempts:target@school.ng', 120);
    store.set('login_attempts_ip:203.0.113.9', 20);
    ttls.set('login_attempts_ip:203.0.113.9', 600);
    const res = await attempt('203.0.113.9', 'right');
    expect(res.status).toBe(429);
    expect(res.body.error.retry_after_seconds).toBe(600);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('when the time left cannot be read, the account stays locked and the message says "within"', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    for (let i = 1; i <= 5; i++) await attempt(`203.0.113.${i}`, 'wrong');
    ttlBroken = true;
    const res = await attempt('203.0.113.6', 'right');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body.error).toEqual({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again within 15 minutes.', retry_after_seconds: null });
    expect(mockSignIn).toHaveBeenCalledTimes(5); // still not checked
  });
});

describe('the per-address lockout key', () => {
  it('is the client (X-Real-IP), not the forwarded hop req.ip would give', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    await request(app).post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.1, 198.51.100.9').set('X-Real-IP', '203.0.113.5')
      .send({ email: 'target@school.ng', password: 'wrong' });
    expect([...store.keys()]).toContain('login_attempts_ip:203.0.113.5');
    expect([...store.keys()]).not.toContain('login_attempts_ip:198.51.100.9');
  });
});

describe('when Redis is unavailable, login fails open', () => {
  // Doctrine 16: "login succeeds with Redis down" is also what a lockout that was never
  // wired produces. So: prove it bites, break Redis, prove the login survives.
  it('the lockout bites while Redis works; once every command throws, a correct password signs in and a wrong one is 401, not 500 — logged', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    for (let i = 1; i <= 5; i++) await attempt(`203.0.113.${i}`, 'wrong');
    expect((await attempt('203.0.113.6', 'right')).body.error.code).toBe('ACCOUNT_LOCKED'); // it bites

    broken = true;
    // This is the residual the decision accepts: with Redis down the lock is not consulted.
    mockSignIn.mockResolvedValue({ data: { user: { id: 'auth-uuid' } }, error: null });
    const ok = await attempt('203.0.113.7', 'right');
    expect(ok.status).toBe(200);
    expect(ok.body.data.access_token).toBeTruthy();

    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });
    const wrong = await attempt('203.0.113.8', 'wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    expect(mockLogger.error).toHaveBeenCalledWith('login_lockout_unavailable', expect.objectContaining({ error: expect.any(String) }));
  });
});
