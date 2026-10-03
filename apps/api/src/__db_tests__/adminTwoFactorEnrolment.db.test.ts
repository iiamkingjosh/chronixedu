/**
 * Platform-admin two-factor, commit 2 of 4: enrolment (migration 056, routes/twoFactor.ts).
 * Supabase Auth is not reachable from the DB suite, so the password re-check is replaced here by a
 * stand-in that accepts one password; the check itself is tested in passwordCheck.test.ts.
 */
jest.mock('../services/passwordCheck', () => ({
  passwordMatches: jest.fn(async (_email: string, password: string) => password === 'the-right-password'),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { pool, seed, IDS } from './helpers';
import twoFactorRoutes from '../routes/twoFactor';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { logger } from '../config/logger';
import { totp, base32Decode, TOTP_STEP_SECONDS } from '../services/totp';
import { consumeRecoveryCode, TOTP_LOCK_AFTER } from '../db/queries/twoFactorStore';

const ADMIN = 'c0a20000-0000-4000-8000-000000000001';
const OTHER_ADMIN = 'c0a20000-0000-4000-8000-000000000002';
const ROOT = 'c0a20000-0000-4000-8000-000000000003';
const ADMIN_EMAIL = 'admin-one@chronix.test';
const CALLER_IP = '102.89.83.240';
const BASE = '/api/super-admin/two-factor';

function app() {
  const a = express();
  a.use(express.json());
  a.use(BASE, twoFactorRoutes);
  a.use('/api/super-admin', superAdminRoutes);
  a.use(errorHandler);
  return a;
}

/** A platform admin's token, issued `ageSeconds` ago. */
function adminToken(userId: string, email: string, ageSeconds = 60): string {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return 'Bearer ' + jwt.sign({ user_id: userId, school_id: null, role: 'super_admin', email, iat }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function addAdmin(id: string, email: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, NULL, $2, '', 'super_admin', 'Platform', 'Admin', true, false)`,
    [id, email]
  );
}

/** Everything the logger was given during a test, as one searchable string. */
let logged: string[] = [];
const spies: jest.SpyInstance[] = [];

async function platformAudit(actionType: string): Promise<Array<{ ip_address: string | null; metadata: Record<string, unknown> | null }>> {
  const { rows } = await pool.query(
    `SELECT ip_address, metadata FROM platform_audit_logs WHERE action_type = $1 ORDER BY created_at`, [actionType]
  );
  return rows;
}

async function allPlatformAuditText(): Promise<string> {
  const { rows } = await pool.query(`SELECT coalesce(metadata::text, '') || ' ' || action_type AS t FROM platform_audit_logs`);
  return rows.map((r) => r.t).join('\n');
}

/** Starts and confirms enrolment for ADMIN; returns what the admin was shown. */
async function enrol(token = adminToken(ADMIN, ADMIN_EMAIL)) {
  const start = await request(app()).post(`${BASE}/enrolment`).set('Authorization', token).set('X-Real-IP', CALLER_IP).send({ password: 'the-right-password' });
  expect(start.status).toBe(200);
  const secret = base32Decode(start.body.data.secret);
  const confirmCode = totp(secret, Date.now() / 1000);
  const confirm = await request(app()).post(`${BASE}/enrolment/confirm`).set('Authorization', token).set('X-Real-IP', CALLER_IP)
    .send({ code: confirmCode });
  expect(confirm.status).toBe(200);
  return { start, confirm, secret, confirmCode, base32: start.body.data.secret as string, codes: confirm.body.data.recovery_codes as string[], fresh: 'Bearer ' + confirm.body.data.access_token };
}

beforeEach(async () => {
  await seed();
  await addAdmin(ADMIN, ADMIN_EMAIL);
  await addAdmin(OTHER_ADMIN, 'admin-two@chronix.test');
  await addAdmin(ROOT, process.env.ROOT_ADMIN_EMAIL!);
  logged = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    spies.push(jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); return logger; }) as never));
  }
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

afterAll(async () => {
  await pool.end();
});

describe('starting enrolment', () => {
  it('needs the password: a wrong one is refused and starts nothing', async () => {
    const wrong = await request(app()).post(`${BASE}/enrolment`).set('Authorization', adminToken(ADMIN, ADMIN_EMAIL)).send({ password: 'not-it' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_PASSWORD');
    expect((await pool.query(`SELECT 1 FROM user_totp WHERE user_id = $1`, [ADMIN])).rowCount).toBe(0);

    // The control: the right password does start it.
    const right = await request(app()).post(`${BASE}/enrolment`).set('Authorization', adminToken(ADMIN, ADMIN_EMAIL)).send({ password: 'the-right-password' });
    expect(right.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM user_totp WHERE user_id = $1`, [ADMIN])).rowCount).toBe(1);
  });

  it('returns the secret once, in a POST body marked not to be stored, and records the start without it', async () => {
    const res = await request(app()).post(`${BASE}/enrolment`).set('Authorization', adminToken(ADMIN, ADMIN_EMAIL)).set('X-Real-IP', CALLER_IP).send({ password: 'the-right-password' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { secret, otpauth_uri } = res.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauth_uri).toContain(`secret=${secret}`);

    // There is no GET that could put it in a URL or a history.
    expect((await request(app()).get(`${BASE}/enrolment`).set('Authorization', adminToken(ADMIN, ADMIN_EMAIL))).status).toBe(404);

    const [started] = await platformAudit('TWO_FACTOR_ENROLMENT_STARTED');
    expect(started.ip_address).toBe(CALLER_IP);
    expect(await allPlatformAuditText()).not.toContain(secret);
    expect(logged.join('\n')).not.toContain(secret);
  });
});

describe('switching it on', () => {
  it('a wrong code leaves it off', async () => {
    const token = adminToken(ADMIN, ADMIN_EMAIL);
    const start = await request(app()).post(`${BASE}/enrolment`).set('Authorization', token).send({ password: 'the-right-password' });
    const secret = base32Decode(start.body.data.secret);
    const wrongCode = totp(secret, Date.now() / 1000 + 10 * TOTP_STEP_SECONDS);
    const res = await request(app()).post(`${BASE}/enrolment/confirm`).set('Authorization', token).send({ code: wrongCode });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
    const status = await request(app()).get(`${BASE}/status`).set('Authorization', token);
    expect(status.body.data.enabled).toBe(false);
  });

  it('one right code switches it on: ten codes shown once, stored hashed, audited with the address, and nothing secret anywhere', async () => {
    const { confirm, base32, codes } = await enrol();
    expect(confirm.headers['cache-control']).toBe('no-store');
    expect(codes).toHaveLength(10);

    const [enabled] = await platformAudit('TWO_FACTOR_ENABLED');
    expect(enabled.ip_address).toBe(CALLER_IP);
    expect(enabled.metadata).toEqual({ recovery_codes_issued: 10 });

    const stored = (await pool.query(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [ADMIN])).rows.map((r) => r.code_hash).join(' ');
    const auditText = await allPlatformAuditText();
    const logText = logged.join('\n');
    for (const secretThing of [base32, ...codes, ...codes.map((c) => c.replace(/-/g, ''))]) {
      expect(stored.includes(secretThing)).toBe(false);
      expect(auditText.includes(secretThing)).toBe(false);
      expect(logText.includes(secretThing)).toBe(false);
    }
  });

  it('ends every other session the admin had, keeps this one on a fresh token, and leaves other admins alone', async () => {
    const oldToken = adminToken(ADMIN, ADMIN_EMAIL, 60);
    const otherAdmin = adminToken(OTHER_ADMIN, 'admin-two@chronix.test', 60);
    // The control: the old token works before enrolment.
    expect((await request(app()).get(`${BASE}/status`).set('Authorization', oldToken)).status).toBe(200);

    const { fresh } = await enrol(oldToken);

    const ended = await request(app()).get(`${BASE}/status`).set('Authorization', oldToken);
    expect(ended.status).toBe(401);
    expect(ended.body.error.code).toBe('SESSION_ENDED');
    const kept = await request(app()).get(`${BASE}/status`).set('Authorization', fresh);
    expect(kept.status).toBe(200);
    expect(kept.body.data).toMatchObject({ enabled: true, unused_recovery_codes: 10 });
    expect((await request(app()).get(`${BASE}/status`).set('Authorization', otherAdmin)).status).toBe(200);
  });

  it('ends the support sessions the admin had open', async () => {
    await pool.query(
      `INSERT INTO support_sessions (platform_admin_id, school_id, impersonated_user_id, reason, actions_taken)
       VALUES ($1, $2, $3, 'probe', '[]')`,
      [ADMIN, IDS.schoolA, IDS.principalA]
    );
    expect((await pool.query(`SELECT 1 FROM support_sessions WHERE platform_admin_id = $1 AND ended_at IS NULL`, [ADMIN])).rowCount).toBe(1);
    await enrol();
    expect((await pool.query(`SELECT 1 FROM support_sessions WHERE platform_admin_id = $1 AND ended_at IS NULL`, [ADMIN])).rowCount).toBe(0);
  });

  it('cannot be started again once it is on', async () => {
    const { fresh } = await enrol();
    const again = await request(app()).post(`${BASE}/enrolment`).set('Authorization', fresh).send({ password: 'the-right-password' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TWO_FACTOR_ALREADY_ON');
  });
});

describe('new recovery codes', () => {
  it('need a current code; the old set stops working and the new one works, audited', async () => {
    const { fresh, secret, codes: oldCodes } = await enrol();
    const nextCode = totp(secret, Date.now() / 1000 + TOTP_STEP_SECONDS);
    const res = await request(app()).post(`${BASE}/recovery-codes`).set('Authorization', fresh).set('X-Real-IP', CALLER_IP).send({ code: nextCode });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const newCodes = res.body.data.recovery_codes as string[];
    expect(newCodes).toHaveLength(10);
    expect(await consumeRecoveryCode(ADMIN, oldCodes[0])).toBe(false);
    expect(await consumeRecoveryCode(ADMIN, newCodes[0])).toBe(true);
    const [regenerated] = await platformAudit('RECOVERY_CODES_REGENERATED');
    expect(regenerated.ip_address).toBe(CALLER_IP);
  });

  it('refuse a code already used: the very code that switched it on', async () => {
    // The exact code, not "the current one": a step boundary between the two calls would otherwise
    // hand this test the next step's code, which is rightly accepted.
    const { fresh, confirmCode } = await enrol();
    const res = await request(app()).post(`${BASE}/recovery-codes`).set('Authorization', fresh).send({ code: confirmCode });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
  });

  it(`lock after ${TOTP_LOCK_AFTER} wrong codes, alert on that first lock, and refuse even the right code while locked`, async () => {
    const { fresh, secret } = await enrol();
    const wrong = totp(secret, Date.now() / 1000 + 10 * TOTP_STEP_SECONDS);
    for (let i = 1; i < TOTP_LOCK_AFTER; i++) {
      const r = await request(app()).post(`${BASE}/recovery-codes`).set('Authorization', fresh).send({ code: wrong });
      expect({ i, status: r.status }).toEqual({ i, status: 400 });
    }
    expect(logged.join('\n')).not.toContain('two_factor_locked');

    const locking = await request(app()).post(`${BASE}/recovery-codes`).set('Authorization', fresh).set('X-Real-IP', CALLER_IP).send({ code: wrong });
    expect(locking.status).toBe(423);
    expect(locking.body.error.code).toBe('TWO_FACTOR_LOCKED');
    expect(logged.filter((l) => l.includes('two_factor_locked'))).toHaveLength(1);
    const [locked] = await platformAudit('TWO_FACTOR_LOCKED');
    expect(locked.metadata).toMatchObject({ failed_attempts: TOTP_LOCK_AFTER, route: 'recovery-codes' });

    const right = totp(secret, Date.now() / 1000 + TOTP_STEP_SECONDS);
    const whileLocked = await request(app()).post(`${BASE}/recovery-codes`).set('Authorization', fresh).send({ code: right });
    expect(whileLocked.status).toBe(423);
  });
});

describe('removing an admin', () => {
  it('clears their two-factor, and the removal is recorded', async () => {
    await enrol();
    expect((await pool.query(`SELECT 1 FROM user_totp WHERE user_id = $1`, [ADMIN])).rowCount).toBe(1);
    const res = await request(app()).delete(`/api/super-admin/admins/${ADMIN}`)
      .set('Authorization', adminToken(ROOT, process.env.ROOT_ADMIN_EMAIL!))
      .send({ confirmation_email: ADMIN_EMAIL });
    expect(res.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM user_totp WHERE user_id = $1`, [ADMIN])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM user_recovery_codes WHERE user_id = $1`, [ADMIN])).rowCount).toBe(0);
    const [removed] = await platformAudit('TWO_FACTOR_REMOVED');
    expect(removed.metadata).toMatchObject({ user_id: ADMIN, by: 'a DELETE on user_totp' });
  });
});

describe('who can reach it', () => {
  it('only platform admins', async () => {
    const principal = `Bearer ${jwt.sign({ user_id: IDS.principalA, school_id: IDS.schoolA, role: 'principal', email: 'p@test' }, process.env.JWT_SECRET!)}`;
    const calls = [
      request(app()).get(`${BASE}/status`),
      request(app()).post(`${BASE}/enrolment`).send({ password: 'the-right-password' }),
      request(app()).post(`${BASE}/enrolment/confirm`).send({ code: '123456' }),
      request(app()).post(`${BASE}/recovery-codes`).send({ code: '123456' }),
    ];
    for (const call of calls) expect((await call.set('Authorization', principal)).status).toBe(403);
    // The control: the same status route answers a platform admin.
    expect((await request(app()).get(`${BASE}/status`).set('Authorization', adminToken(ADMIN, ADMIN_EMAIL))).status).toBe(200);
  });
});
