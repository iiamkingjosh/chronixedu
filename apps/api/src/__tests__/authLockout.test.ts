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

process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

const mockSignIn = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: (...a: unknown[]) => mockSignIn(...a) } },
  supabaseAdmin: { auth: { admin: {} } },
}));
jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() })),
  Pool: jest.fn().mockImplementation(() => ({ query: jest.fn(), connect: jest.fn(), end: jest.fn(), on: jest.fn() })),
}));
jest.mock('../db/queries/users');
jest.mock('../db/queries/auditLog');

/** The four ioredis commands the lockout uses, over a plain map. TTLs are not modelled. */
const store = new Map<string, number>();
jest.mock('../middleware/rateLimit', () => ({
  redis: {
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    incr: async (k: string) => { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
    expire: async () => 1,
    del: async (k: string) => { store.delete(k); return 1; },
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

beforeEach(() => { store.clear(); mockSignIn.mockReset(); });

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
