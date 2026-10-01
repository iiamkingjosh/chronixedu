import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { errorHandler } from '../middleware/errorHandler';

process.env.JWT_SECRET = 'test-secret';
(process.env as Record<string, string>).NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.SEED_SECRET = 'test-seed-secret';

const mockSignIn = jest.fn();
const mockAdminCreateUser = jest.fn();
const mockAdminListUsers = jest.fn();
const mockAdminGetUser = jest.fn();
const mockAdminUpdateUserById = jest.fn();

jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignIn(...args),
      resetPasswordForEmail: jest.fn(),
    },
  },
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: (...args: unknown[]) => mockAdminCreateUser(...args),
        listUsers: (...args: unknown[]) => mockAdminListUsers(...args),
        getUser: (...args: unknown[]) => mockAdminGetUser(...args),
        updateUserById: (...args: unknown[]) => mockAdminUpdateUserById(...args),
      },
    },
  },
}));

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: (...args: unknown[]) => mockQuery(...args),
    end: mockEnd,
  })),
  Pool: jest.fn().mockImplementation(() => ({
    // verifyToken / requirePasswordChanged look the caller up on the pool; answer those
    // as before. Everything else goes to mockQuery, the same queue the tests already
    // drive — /create-user and /seed-test-user moved from the login Client to the pool
    // (the login connection now serves POST /login only).
    query: (sql: string, params?: unknown[]) =>
      /SELECT (is_active|must_change_password) FROM users/.test(sql)
        ? Promise.resolve({ rows: [{ is_active: true, must_change_password: false }] })
        : mockQuery(sql, params),
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  })),
}));

jest.mock('../db/queries/users');
jest.mock('../db/queries/auditLog');

import authRouter from '../routes/auth';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use(errorHandler);

function makeToken(role: string) {
  return jwt.sign(
    { user_id: 'user-1', role, school_id: 'school-1', email: 'admin@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks does not flush mockResolvedValueOnce queues — reset just the
  // pg.Client.query queue so stale values from one test cannot bleed into the next.
  mockQuery.mockReset();
});

describe('auth middleware error envelope', () => {
  it('returns 401 envelope when Authorization header is missing', async () => {
    const res = await request(app).get('/api/auth/test-role');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' },
    });
  });

  it('returns 401 envelope for an invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/test-role')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
    });
  });

  it('returns 403 envelope when role is insufficient', async () => {
    const token = makeToken('teacher');
    const res = await request(app)
      .get('/api/auth/test-role')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });
  });
});

describe('GET /api/auth/test-role', () => {
  it('returns a success envelope with role under data', async () => {
    const token = makeToken('principal');
    const res = await request(app)
      .get('/api/auth/test-role')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { role: 'principal' } });
  });
});

describe('POST /api/auth/login', () => {
  it('returns a 400 envelope for missing credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Valid email and password are required.' },
    });
  });

  it('returns a 401 envelope for invalid credentials', async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
    });
  });

  it('returns a success envelope with access_token and user under data', async () => {
    mockSignIn.mockResolvedValueOnce({ data: { user: { id: 'auth-uuid-1' } }, error: null });
    const passwordHash = bcrypt.hashSync('password123', 10);
    mockQuery
      // 1. local user SELECT by Supabase auth UUID
      .mockResolvedValueOnce({
        rows: [{
          id: 'local-uuid-1',
          school_id: 'school-1',
          role: 'teacher',
          title: null,
          email: 'a@b.com',
          first_name: 'A',
          last_name: 'B',
          password_hash: passwordHash,
          is_active: true,
          support_code: '123456',
        }],
      })
      // 2. UPDATE last_login_at
      .mockResolvedValueOnce({ rows: [] })
      // 3. schools.subscription_tier lookup
      .mockResolvedValueOnce({ rows: [{ subscription_tier: 'premium' }] });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.user).toEqual({
      user_id: 'local-uuid-1',
      school_id: 'school-1',
      role: 'teacher',
      email: 'a@b.com',
      title: null,
      first_name: 'A',
      last_name: 'B',
      subscription_tier: 'premium',
      support_code: '123456',
    });

    const decoded = jwt.decode(res.body.data.access_token) as { subscription_tier?: string };
    expect(decoded.subscription_tier).toBe('premium');
  });

  it('returns a 403 envelope for a suspended account', async () => {
    mockSignIn.mockResolvedValueOnce({ data: { user: { id: 'auth-uuid-1' } }, error: null });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'local-uuid-1',
        school_id: 'school-1',
        role: 'teacher',
        title: null,
        email: 'a@b.com',
        first_name: 'A',
        last_name: 'B',
        is_active: false,
      }],
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'password123' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'ACCOUNT_SUSPENDED', message: 'This account has been suspended. Contact your administrator.' },
    });
  });
});

describe('POST /api/auth/create-user', () => {
  it('returns a 400 envelope for missing fields', async () => {
    const token = makeToken('super_admin');
    const res = await request(app)
      .post('/api/auth/create-user')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@test.com' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid input: expected string, received undefined' },
    });
  });

  it('returns a success envelope with user_id under data', async () => {
    mockAdminCreateUser.mockResolvedValueOnce({ data: { user: { id: 'new-uuid-1' } }, error: null });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const token = makeToken('super_admin');
    const res = await request(app)
      .post('/api/auth/create-user')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@test.com', password: 'password123', role: 'teacher' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { user_id: 'new-uuid-1' } });
  });
});

describe('POST /api/auth/seed-test-user', () => {
  it('returns a 400 envelope for missing required fields', async () => {
    const res = await request(app)
      .post('/api/auth/seed-test-user')
      .set('x-seed-secret', 'test-seed-secret')
      .send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Missing required fields: email, password, role, first_name, last_name',
      },
    });
  });

  it('returns a success envelope with user_id and reused_auth under data', async () => {
    mockAdminListUsers.mockResolvedValueOnce({ data: { users: [] } });
    mockAdminCreateUser.mockResolvedValueOnce({ data: { user: { id: 'seeded-uuid-1' } }, error: null });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/auth/seed-test-user')
      .set('x-seed-secret', 'test-seed-secret')
      .send({
        email: 'seed@test.com',
        password: 'password123',
        role: 'teacher',
        first_name: 'Seed',
        last_name: 'User',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { user_id: 'seeded-uuid-1', reused_auth: false },
    });
  });
});

describe('POST /api/auth/forgot-password — one answer for every address', () => {
  // The defect (work order 1 Oct 2026, step 1): a known address whose send failed got 500
  // RESET_EMAIL_FAILED with Supabase's own text, an unknown address got 200, so the endpoint
  // listed every registered user, and did so exactly while mail was down. A known address also
  // waited on the Supabase round trip and an unknown one did not.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { supabase } = require('../supabaseClient');
  const { findUserByEmail } = require('../db/queries/users');
  const { logger } = require('../config/logger');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const mockReset = supabase.auth.resetPasswordForEmail as jest.Mock;
  const mockFindUser = findUserByEmail as jest.Mock;

  const KNOWN = 'principal@known.test';
  const UNKNOWN = 'nobody@unknown.test';
  const ask = (email: string) => request(app).post('/api/auth/forgot-password').send({ email });

  /** Resolves when the handler logs `event` at `level`: a signal the code emits, not a sleep. */
  function whenLogged(level: 'info' | 'error', event: string): Promise<unknown[]> {
    return new Promise(resolve => {
      jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        if (args[0] === event) resolve(args);
        return logger;
      }) as never);
    });
  }

  beforeEach(() => {
    mockFindUser.mockImplementation(async (email: string) => (email === KNOWN ? { id: 'user-known', email } : null));
  });
  afterEach(() => jest.restoreAllMocks());

  it('a known address really is sent a reset, and an unknown one is not (the control)', async () => {
    mockReset.mockResolvedValue({ data: {}, error: null });
    const accepted = whenLogged('info', 'password_reset_email_accepted');

    const known = await ask(KNOWN);
    expect(await accepted).toEqual(['password_reset_email_accepted', { user_id: 'user-known' }]);
    const unknown = await ask(UNKNOWN);

    expect(known.status).toBe(200);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockReset).toHaveBeenCalledWith(KNOWN, expect.objectContaining({ redirectTo: expect.any(String) }));
    expect(unknown.body).toEqual(known.body);
  });

  it.each([
    ['returns an error', () => mockReset.mockResolvedValue({ data: null, error: { message: 'Error sending recovery email', status: 500 } })],
    ['throws', () => mockReset.mockRejectedValue(new Error('fetch failed'))],
  ])('a known address whose send %s gets exactly what an unknown address gets', async (_how, failSend) => {
    failSend();
    const failed = whenLogged('error', 'password_reset_email_failed');

    const known = await ask(KNOWN);
    const unknown = await ask(UNKNOWN);

    // Both, asserted against each other: checking only the unknown case passed on the old code.
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(known.body)).not.toMatch(/recovery|fetch failed|RESET_EMAIL_FAILED/);

    // The known branch did run, and the failure is on the server, by user id and not address.
    expect(mockReset).toHaveBeenCalledTimes(1);
    const [, meta] = (await failed) as [string, Record<string, unknown>];
    expect(meta.user_id).toBe('user-known');
    expect(JSON.stringify(meta)).not.toContain(KNOWN);
  });

  it('answers a known address without waiting for Supabase, as fast as an unknown one', async () => {
    // Supabase does not answer until this test lets it. The old handler awaited it, so this
    // request never completed; the answer must not depend on the send at all.
    let finishSend!: () => void;
    mockReset.mockReturnValue(new Promise(resolve => { finishSend = () => resolve({ data: {}, error: null }); }));
    const accepted = whenLogged('info', 'password_reset_email_accepted');

    const known = await ask(KNOWN);
    expect(known.status).toBe(200);
    expect(mockReset).toHaveBeenCalledTimes(1); // the send was started, and is still pending

    finishSend();
    await accepted;
    expect((await ask(UNKNOWN)).body).toEqual(known.body);
  });
});
