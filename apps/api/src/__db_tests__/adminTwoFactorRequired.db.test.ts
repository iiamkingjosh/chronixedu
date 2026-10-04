/**
 * Platform-admin two-factor, commit 4 of 4: who must have it, and what a token needs (migration 058,
 * middleware/auth.ts).
 *
 * Two rules, each tested in both directions, because "refuses everything" and "refuses nothing" each
 * pass a one-sided test:
 *  - an admin with two-factor on needs a token that records the second factor, everywhere;
 *  - an admin who must switch it on, and has not, reaches only TWO_FACTOR_SETUP_ROUTES.
 * The controls are the admins who existed before 058 (two_factor_required false: optional, Moses,
 * 3 Oct 2026) and school users, neither of whom is touched.
 *
 * The app below mounts the routers at the prefixes index.ts uses, behind the same chain, so the
 * full-path matching verifyToken does is exercised as it runs in production. The static half (no
 * other route is reachable) is twoFactorSetupRoutes.test.ts.
 */
jest.mock('../services/passwordCheck', () => ({
  passwordMatches: jest.fn(async (_email: string, password: string) => password === 'the-right-password'),
}));
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    createUser: jest.fn(async () => ({ data: { user: { id: require('crypto').randomUUID() } }, error: null })),
    listUsers: jest.fn(async () => ({ data: { users: [] }, error: null })),
    generateLink: jest.fn(async () => ({ data: { properties: { action_link: 'https://auth.example.test/verify?token=t' } }, error: null })),
  } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => true),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { pool, seed, IDS, tokens } from './helpers';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import schoolsRoutes from '../routes/schools';
import twoFactorRoutes from '../routes/twoFactor';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { totp, base32Decode } from '../services/totp';

// The dev-only seed route is registered at import, and only with a secret set (routes/auth.ts).
process.env.SEED_SECRET = 'seed-secret-for-this-suite';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authRoutes = require('../routes/auth').default as express.Router;

const ROOT = 'c0a40000-0000-4000-8000-000000000001';
const BEFORE = 'c0a40000-0000-4000-8000-000000000002'; // an admin who existed before 058
const NEW = 'c0a40000-0000-4000-8000-000000000003'; // an admin created since: must enrol
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL!;
const SETUP = '/api/super-admin/two-factor';

/** index.ts's mounts, for the routers these tests reach. */
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRoutes);
  a.use('/api/schools', detectSupportSession);
  a.use('/api/schools', verifyToken);
  a.use('/api/schools', requirePasswordChanged);
  a.use('/api/schools', requireActiveSchool);
  a.use('/api/schools', schoolsRoutes);
  a.use(SETUP, twoFactorRoutes);
  a.use('/api/super-admin', superAdminRoutes);
  a.use(errorHandler);
  return a;
}

/** A platform admin's token. `iat` defaults to a second from now, after any session cut-off. */
function adminToken(userId: string, email: string, extra: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000) + 1;
  return 'Bearer ' + jwt.sign({ user_id: userId, school_id: null, role: 'super_admin', email, iat, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function addAdmin(id: string, email: string, required: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password, two_factor_required)
     VALUES ($1, NULL, $2, '', 'super_admin', 'Platform', 'Admin', true, false, $3)`,
    [id, email, required]
  );
}

/** Switches two-factor on for an admin through the setup routes; returns the token enrolment hands back. */
async function enrol(id: string, email: string, token = adminToken(id, email)): Promise<string> {
  const start = await request(app()).post(`${SETUP}/enrolment`).set('Authorization', token).send({ password: 'the-right-password' });
  expect(start.status).toBe(200);
  const code = totp(base32Decode(start.body.data.secret), Date.now() / 1000);
  const confirm = await request(app()).post(`${SETUP}/enrolment/confirm`).set('Authorization', token).send({ code });
  expect(confirm.status).toBe(200);
  return 'Bearer ' + confirm.body.data.access_token;
}

const get = (path: string, token: string) => request(app()).get(path).set('Authorization', token);

beforeEach(async () => {
  await seed();
  await addAdmin(ROOT, ROOT_EMAIL, false);
  await addAdmin(BEFORE, 'before@chronix.test', false);
  await addAdmin(NEW, 'new@chronix.test', true);
});

afterAll(async () => {
  await pool.end();
});

describe('the database refuses a platform admin whose requirement is not stated (CHECK, not a trigger)', () => {
  const insert = (id: string, role: string, required: boolean | null) => pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, two_factor_required)
     VALUES ($1, NULL, $2, '', $3, 'X', 'Y', $4)`, [id, `${id}@chronix.test`, role, required]);

  it('a super_admin stating it is accepted; the same row without it is refused', async () => {
    await expect(insert('c0a40000-0000-4000-8000-0000000000a1', 'super_admin', true)).resolves.toBeDefined();
    await expect(insert('c0a40000-0000-4000-8000-0000000000a2', 'super_admin', false)).resolves.toBeDefined();
    await expect(insert('c0a40000-0000-4000-8000-0000000000a3', 'super_admin', null)).rejects.toThrow(/users_admin_states_two_factor/);
  });

  it('it does not apply to anyone else: a teacher carries NULL', async () => {
    await expect(insert('c0a40000-0000-4000-8000-0000000000a4', 'teacher', null)).resolves.toBeDefined();
  });

  it('making someone a super_admin without stating it is refused too', async () => {
    await expect(pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [IDS.mathTeacher]))
      .rejects.toThrow(/users_admin_states_two_factor/);
    await expect(pool.query(`UPDATE users SET role = 'super_admin', two_factor_required = true WHERE id = $1`, [IDS.mathTeacher]))
      .resolves.toBeDefined();
  });

  it('is a CHECK constraint, which DISABLE TRIGGER ALL cannot switch off', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'users_admin_states_two_factor' AND contype = 'c'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/role <> 'super_admin'.*two_factor_required IS NOT NULL/);
  });
});

describe('every path that creates a platform admin says it must enrol', () => {
  const required = async (email: string) =>
    (await pool.query(`SELECT two_factor_required FROM users WHERE email = $1`, [email])).rows[0]?.two_factor_required;

  it('POST /super-admin/admins', async () => {
    const res = await request(app()).post('/api/super-admin/admins').set('Authorization', adminToken(ROOT, ROOT_EMAIL))
      .send({ email: 'added@chronix.test', email_confirmation: 'added@chronix.test', first_name: 'Ad', last_name: 'Ded' });
    expect(res.status).toBe(201);
    expect(await required('added@chronix.test')).toBe(true);
  });

  it('POST /auth/create-user: true for a super_admin, NULL for anyone else', async () => {
    const make = (email: string, role: string, schoolId?: string) => request(app()).post('/api/auth/create-user')
      .set('Authorization', adminToken(ROOT, ROOT_EMAIL))
      .send({ email, password: 'a-long-password', role, first_name: 'Cre', last_name: 'Ated', ...(schoolId ? { school_id: schoolId } : {}) });
    expect((await make('made-admin@chronix.test', 'super_admin')).status).toBe(200);
    expect((await make('made-teacher@chronix.test', 'teacher', IDS.schoolA)).status).toBe(200);
    expect(await required('made-admin@chronix.test')).toBe(true);
    expect(await required('made-teacher@chronix.test')).toBeNull();
  });

  it('the dev seed route: true for a new super_admin, and an existing admin keeps what was decided', async () => {
    const seedUser = (email: string, role: string) => request(app()).post('/api/auth/seed-test-user')
      .set('x-seed-secret', process.env.SEED_SECRET!)
      .send({ email, password: 'a-long-password', role, first_name: 'See', last_name: 'Ded' });
    expect((await seedUser('seeded-admin@chronix.test', 'super_admin')).status).toBe(200);
    expect((await seedUser('seeded-teacher@chronix.test', 'teacher')).status).toBe(200);
    expect(await required('seeded-admin@chronix.test')).toBe(true);
    expect(await required('seeded-teacher@chronix.test')).toBeNull();

    // Re-seeding an admin who existed before 058 reuses their Auth identity, so the upsert hits
    // their row: their false stays false rather than being overwritten with the new-admin default.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { supabaseAdmin } = require('../supabaseClient');
    (supabaseAdmin.auth.admin.listUsers as jest.Mock).mockResolvedValueOnce({ data: { users: [{ id: BEFORE, email: 'before@chronix.test' }] }, error: null });
    expect((await seedUser('before@chronix.test', 'super_admin')).body.data).toMatchObject({ user_id: BEFORE, reused_auth: true });
    expect(await required('before@chronix.test')).toBe(false);
  });
});

describe('an admin who must switch two-factor on, and has not, reaches only the setup routes', () => {
  const token = () => adminToken(NEW, 'new@chronix.test');

  it('the setup routes answer, and say it is required', async () => {
    const status = await get(`${SETUP}/status`, token());
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ required: true, enabled: false });
  });

  it('everything else is refused with TWO_FACTOR_SETUP_REQUIRED: platform, school and auth routes', async () => {
    const attempts: Array<[string, () => Promise<request.Response>]> = [
      ['GET platform', () => get('/api/super-admin/admins', token())],
      ['GET school', () => get(`/api/schools/${IDS.schoolA}`, token())],
      ['POST recovery codes', () => request(app()).post(`${SETUP}/recovery-codes`).set('Authorization', token()).send({ code: '123456' })],
      ['POST create-user', () => request(app()).post('/api/auth/create-user').set('Authorization', token())
        .send({ email: 'x@chronix.test', password: 'a-long-password', role: 'teacher', school_id: IDS.schoolA })],
      // A near miss of an allowlisted address fails closed.
      ['GET status/ (trailing slash)', () => get(`${SETUP}/status/`, token())],
    ];
    for (const [what, attempt] of attempts) {
      const res = await attempt();
      expect({ what, status: res.status, code: res.body.error?.code })
        .toEqual({ what, status: 403, code: 'TWO_FACTOR_SETUP_REQUIRED' });
    }
  });

  it('control: an admin who existed before 058 is not touched, so the refusal above is not a refusal of everyone', async () => {
    const before = adminToken(BEFORE, 'before@chronix.test');
    expect((await get('/api/super-admin/admins', before)).status).toBe(200);
    expect((await get(`/api/schools/${IDS.schoolA}`, before)).status).toBe(200);
    expect((await get(`${SETUP}/status`, before)).body.data).toMatchObject({ required: false, enabled: false });
  });

  it('an admin token whose row is gone is refused outright, never treated as exempt', async () => {
    // No users row at all, so no stated exemption. Commit 4 confined such a token to the setup routes;
    // since fix (b) (4 Oct 2026) a missing row refuses every token, the setup routes included.
    const ghost = adminToken('c0a40000-0000-4000-8000-0000000000ff', 'ghost@chronix.test');
    for (const path of ['/api/super-admin/admins', `${SETUP}/status`]) {
      const res = await get(path, ghost);
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({ path, status: 401, code: 'ACCOUNT_NOT_FOUND' });
    }
  });

  it('control: school users are not touched', async () => {
    expect((await get(`/api/schools/${IDS.schoolA}`, tokens.principalA())).status).toBe(200);
  });

  it('once it is on, the token enrolment hands back works everywhere at once', async () => {
    const fresh = await enrol(NEW, 'new@chronix.test', token());
    expect(jwt.decode(fresh.replace('Bearer ', ''))).toMatchObject({ second_factor: 'totp' });
    expect((await get('/api/super-admin/admins', fresh)).status).toBe(200);
    expect((await get(`/api/schools/${IDS.schoolA}`, fresh)).status).toBe(200);
  });
});

describe('an admin with two-factor on needs a token that records the second factor', () => {
  it('a token without it is refused everywhere, the setup routes included, with SECOND_FACTOR_REQUIRED', async () => {
    await enrol(BEFORE, 'before@chronix.test');
    const passwordOnly = adminToken(BEFORE, 'before@chronix.test');
    for (const path of ['/api/super-admin/admins', `/api/schools/${IDS.schoolA}`, `${SETUP}/status`]) {
      const res = await get(path, passwordOnly);
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({ path, status: 401, code: 'SECOND_FACTOR_REQUIRED' });
    }
  });

  it('the same token recording either factor is accepted; an unknown factor is not', async () => {
    await enrol(BEFORE, 'before@chronix.test');
    for (const factor of ['totp', 'recovery_code']) {
      expect((await get('/api/super-admin/admins', adminToken(BEFORE, 'before@chronix.test', { second_factor: factor }))).status).toBe(200);
    }
    const res = await get('/api/super-admin/admins', adminToken(BEFORE, 'before@chronix.test', { second_factor: 'password' }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SECOND_FACTOR_REQUIRED');
  });

  it('control: before enrolling, the same claimless token was accepted, so the refusal is the enrolment', async () => {
    expect((await get('/api/super-admin/admins', adminToken(BEFORE, 'before@chronix.test'))).status).toBe(200);
  });
});

describe('the state is visible', () => {
  it('the Admins list says, for each admin, whether it is on and whether it is required', async () => {
    await enrol(BEFORE, 'before@chronix.test');
    const res = await get('/api/super-admin/admins', adminToken(ROOT, ROOT_EMAIL));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.data as Array<{ id: string; two_factor_on: boolean; two_factor_required: boolean }>)
      .map(a => [a.id, { on: a.two_factor_on, required: a.two_factor_required }]));
    expect(byId[BEFORE]).toEqual({ on: true, required: false });
    expect(byId[NEW]).toEqual({ on: false, required: true });
    expect(byId[ROOT]).toEqual({ on: false, required: false });
  });
});
