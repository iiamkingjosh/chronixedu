/**
 * The suspension and read-only guards, and sign-in to a suspended school (SECURITY.md Round 42).
 *
 * Both guards used to test the RAW first path segment against a uuid pattern and let anything else
 * through, while the route reads the DECODED segment. So `a0000000%2D0000-…` skipped both guards and
 * still reached the right school: a suspended school, or a lapsed trial, could write on every school
 * route. Now an address with no school id is exactly `/` (POST /api/schools, the one such route), and
 * any other first segment must decode to a uuid or the request is refused. And sign-in used to issue
 * fresh tokens to the members of a suspended school, because it checked only the account.
 *
 * Supabase Auth is not reachable from the DB suite, so for sign-in the password check is a stand-in
 * that accepts one password and the lockout is a spy, as in adminTwoFactorSignIn.db.test.ts.
 * Every refusal is shown beside a request that succeeds (doctrine 16).
 */
const mockUserIdsByEmail: Record<string, string> = {};
jest.mock('../services/passwordCheck', () => ({
  signInAndRevoke: jest.fn(async (email: string, password: string) =>
    password === 'the-right-password' ? mockUserIdsByEmail[email] ?? null : null),
  passwordMatches: jest.fn(async (_e: string, password: string) => password === 'the-right-password'),
}));
jest.mock('../services/loginLockout', () => ({
  isLockedOut: jest.fn(async () => false),
  recordFailedAttempt: jest.fn(async () => ({ counted: true, locked: false })),
  clearFailedAttempts: jest.fn(async () => undefined),
}));

import express from 'express';
import request from 'supertest';
import { buildApp, seed, IDS as I, pool, token, tokens } from './helpers';
import authRoutes from '../routes/auth';
import { errorHandler } from '../middleware/errorHandler';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { cache, schoolCacheKey } from '../services/cacheService';
import { logger } from '../config/logger';

const app = buildApp();
const signInApp = express();
signInApp.use(express.json());
signInApp.use('/api/auth', authRoutes);
signInApp.use(errorHandler);

const SA = 'a5a00000-0000-4000-8000-000000000042';
const sa = () => token(SA, 'super_admin', I.schoolA);

/** The school id as a client could send it: its first hyphen percent-encoded. Express decodes it for the route. */
const encoded = (schoolId: string) => schoolId.replace('-', '%2D');

const forgetSchools = () => {
  cache.del(schoolCacheKey(I.schoolA, 'data'));
  cache.del(schoolCacheKey(I.schoolB, 'data'));
};
const suspend = async (schoolId: string) => {
  await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [schoolId]);
  forgetSchools();
};
const makeReadOnly = async (schoolId: string) => {
  await pool.query(
    `INSERT INTO platform_subscriptions (school_id, plan, subscription_status, trial_ends_at)
     VALUES ($1, 'trial', 'read_only', now() - interval '30 days')`, [schoolId]);
  forgetSchools();
};

const getNotices = (schoolPart: string, auth = tokens.principalA()) =>
  request(app).get(`/api/schools/${schoolPart}/notices`).set('Authorization', auth);
const postNotice = (schoolPart: string, auth = tokens.principalA()) =>
  request(app).post(`/api/schools/${schoolPart}/notices`).set('Authorization', auth)
    .send({ class_id: I.jss2a, title: 'Sports day', body: 'Friday, 10am.' });
const noticeCount = async () => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM notices`)).rows[0].n;

beforeEach(async () => {
  await seed();
  forgetSchools();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'sa42@chronix.test', 'x', 'super_admin', 'Super', 'Admin', true, 'subject', false, false)`, [SA]);
});

afterAll(async () => {
  await pool.end();
});

describe('a percent-encoded school id is checked against the school the route will use', () => {
  it('reaches the route while the school is active, and is refused once it is suspended', async () => {
    expect((await getNotices(encoded(I.schoolA))).status).toBe(200);
    await suspend(I.schoolA);
    for (const part of [I.schoolA, encoded(I.schoolA)]) {
      const res = await getNotices(part);
      expect({ part, status: res.status, code: res.body.error?.code }).toEqual({ part, status: 403, code: 'SCHOOL_SUSPENDED' });
    }
  });

  it('writes while the subscription is writable, and is refused once it is read-only, where reads still work', async () => {
    expect((await postNotice(encoded(I.schoolA))).status).toBe(201);
    await makeReadOnly(I.schoolA);
    for (const part of [I.schoolA, encoded(I.schoolA)]) {
      const res = await postNotice(part);
      expect({ part, status: res.status, code: res.body.error?.code }).toEqual({ part, status: 423, code: 'SCHOOL_READ_ONLY' });
    }
    expect(await noticeCount()).toBe(1);
    expect((await getNotices(encoded(I.schoolA))).status).toBe(200);
  });
});

describe('a first segment that is not a school id is refused, never passed along', () => {
  // The guard's own JSON 404, not Express's "Cannot GET" page: the request stopped at the guard.
  const cases: Array<[string, string]> = [
    ['a word', 'not-a-school'],
    ['an empty segment (one extra slash)', ''],
    ['a double-encoded id', I.schoolA.replace('-', '%252D')],
    ['a broken percent escape', '%E0%A4%A'],
  ];
  for (const [who, auth] of [['a principal', () => tokens.principalA()], ['a platform admin', sa]] as const) {
    it(`${who}: every malformed school id gets 404`, async () => {
      expect((await getNotices(I.schoolA, auth())).status).toBe(200);
      for (const [what, part] of cases) {
        const res = await getNotices(part, auth());
        expect({ what, status: res.status, code: res.body.error?.code }).toEqual({ what, status: 404, code: 'NOT_FOUND' });
      }
    });
  }

  it('a write to a malformed school id is refused the same way, and writes nothing', async () => {
    for (const part of ['not-a-school', '', '%E0%A4%A']) {
      const res = await postNotice(part);
      expect({ part, status: res.status }).toEqual({ part, status: 404 });
    }
    expect(await noticeCount()).toBe(0);
    expect((await postNotice(I.schoolA)).status).toBe(201);
  });
});

describe('POST /api/schools, the one route with no school id', () => {
  it('still reaches its handler: a platform admin creates, a principal is refused by the route itself', async () => {
    const created = await request(app).post('/api/schools').set('Authorization', sa()).send({ name: 'Guard Test School', is_demo: true });
    expect(created.status).toBe(201);
    const refused = await request(app).post('/api/schools').set('Authorization', tokens.principalA()).send({ name: 'Not Allowed', is_demo: true });
    expect({ status: refused.status, code: refused.body.error?.code }).toEqual({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('the read-only guard refuses a write it cannot judge', () => {
  it('a write with a school id but no school loaded is a 500 and an alert, never a pass', async () => {
    // Mounted without requireActiveSchool, which is what loads the school: the state the guard
    // must never read as "writable".
    const bare = express();
    bare.use((req, _res, next) => {
      req.user = { user_id: I.principalA, role: 'principal', school_id: I.schoolA } as typeof req.user;
      next();
    });
    bare.use(requireWritableSubscription);
    bare.get('/:schoolId/notices', (_req, res) => { res.json({ success: true }); });
    bare.post('/:schoolId/notices', (_req, res) => { res.status(201).json({ success: true }); });
    const errors = jest.spyOn(logger, 'error').mockImplementation((() => logger) as never);
    try {
      expect((await request(bare).get(`/${I.schoolA}/notices`)).status).toBe(200);
      const res = await request(bare).post(`/${I.schoolA}/notices`).send({});
      expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 500, code: 'SCHOOL_STATE_UNAVAILABLE' });
      expect(errors.mock.calls.map(c => c[0])).toContain('school_guard_state_missing');
    } finally {
      errors.mockRestore();
    }
  });
});

describe('signing in to a suspended school', () => {
  const PRINCIPAL_EMAIL = 'principal-a@school-a.test';
  const PARENT_EMAIL = 'parent-a@school-a.test';
  const signIn = (email: string) =>
    request(signInApp).post('/api/auth/login').set('X-Real-IP', '102.89.40.17').send({ email, password: 'the-right-password' });

  beforeEach(async () => {
    // The seed's addresses (<id>@test) are not ones the sign-in form accepts.
    await pool.query(`UPDATE users SET email = $2 WHERE id = $1`, [I.principalA, PRINCIPAL_EMAIL]);
    await pool.query(`UPDATE users SET email = $2 WHERE id = $1`, [I.parentA, PARENT_EMAIL]);
    mockUserIdsByEmail[PRINCIPAL_EMAIL] = I.principalA;
    mockUserIdsByEmail[PARENT_EMAIL] = I.parentA;
  });

  it('a member of an active school signs in; once it is suspended, nobody in it gets a token', async () => {
    const ok = await signIn(PRINCIPAL_EMAIL);
    expect(ok.status).toBe(200);
    expect(ok.body.data.access_token).toEqual(expect.any(String));
    await suspend(I.schoolA);
    for (const email of [PRINCIPAL_EMAIL, PARENT_EMAIL]) {
      const res = await signIn(email);
      expect({ email, status: res.status, code: res.body.error?.code, token: res.body.data?.access_token })
        .toEqual({ email, status: 403, code: 'SCHOOL_SUSPENDED', token: undefined });
    }
  });

  it('a read-only school still signs in, because paying is how it restores itself', async () => {
    await makeReadOnly(I.schoolA);
    const res = await signIn(PRINCIPAL_EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toEqual(expect.any(String));
  });
});
