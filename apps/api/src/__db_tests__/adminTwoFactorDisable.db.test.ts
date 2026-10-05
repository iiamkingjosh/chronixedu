/**
 * Turning two-factor off (POST /two-factor/disable, 4 Oct 2026). It reverses the 3 Oct decision that
 * there would be no way to, on the conditions that decision set. Tested here:
 *  - never a session alone: the password and a current code, or one recovery code;
 *  - refused while the account is marked required;
 *  - it leaves nothing to bring back: the secret, a waiting phone move and every recovery code go;
 *  - every other session ends, and it is recorded with the previous state.
 *
 * Supabase Auth is not reachable from the DB suite, so the password checks are stand-ins that accept
 * one password, and the sign-in lockout (Redis) is a spy. Everything else is real. Every refusal is
 * shown beside the same request succeeding (doctrine 16).
 */
const mockUserIdsByEmail: Record<string, string> = {};
jest.mock('../services/passwordCheck', () => ({
  signInAndRevoke: jest.fn(async (email: string, password: string) =>
    password === 'the-right-password' ? mockUserIdsByEmail[email] ?? null : null),
  passwordMatches: jest.fn(async (_email: string, password: string) => password === 'the-right-password'),
}));
jest.mock('../services/loginLockout', () => ({
  isLockedOut: jest.fn(async () => false),
  recordFailedAttempt: jest.fn(async () => ({ counted: true, locked: false })),
  clearFailedAttempts: jest.fn(async () => undefined),
}));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => 'sent') }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { pool, seed, IDS } from './helpers';
import authRoutes from '../routes/auth';
import twoFactorRoutes from '../routes/twoFactor';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { totp, generateTotpSecret, TOTP_STEP_SECONDS } from '../services/totp';
import { generateRecoveryCodes } from '../services/recoveryCodes';
import {
  savePendingTotpSecret, replaceRecoveryCodes, savePendingDeviceMove, disableTwoFactor, isTwoFactorActive,
} from '../db/queries/twoFactorStore';
import * as lockout from '../services/loginLockout';

const ADMIN = 'c0a60000-0000-4000-8000-000000000001';
const ROOT = 'c0a60000-0000-4000-8000-000000000002';
const ADMIN_EMAIL = 'switcher@chronix.test';
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL!;
const CALLER_IP = '102.89.44.217';
const SETUP = '/api/super-admin/two-factor';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRoutes);
  a.use(SETUP, twoFactorRoutes);
  a.use('/api/super-admin', superAdminRoutes);
  a.use(errorHandler);
  return a;
}

/** A platform admin's token, issued a second from now and recording the second factor, unless asked. */
function adminToken(userId: string, email: string, { ageSeconds = -1, secondFactor = true } = {}): string {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  const claims = { user_id: userId, school_id: null, role: 'super_admin', email, iat, ...(secondFactor ? { second_factor: 'totp' } : {}) };
  return 'Bearer ' + jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' });
}
const token = () => adminToken(ADMIN, ADMIN_EMAIL);

async function addAdmin(id: string, email: string, required: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password, two_factor_required)
     VALUES ($1, NULL, $2, '', 'super_admin', 'Platform', 'Admin', true, false, $3)`,
    [id, email, required]
  );
  mockUserIdsByEmail[email] = id;
}

async function enrol(id: string): Promise<{ secret: Buffer; codes: string[] }> {
  const secret = generateTotpSecret();
  const codes = generateRecoveryCodes();
  await savePendingTotpSecret(id, secret);
  await pool.query(`UPDATE user_totp SET activated_at = now() WHERE user_id = $1`, [id]);
  await replaceRecoveryCodes(id, codes);
  return { secret, codes };
}

const now = () => Date.now() / 1000;
let secret: Buffer;
let codes: string[];

const disable = (body: Record<string, string>, t = token()) =>
  request(app()).post(`${SETUP}/disable`).set('Authorization', t).set('X-Real-IP', CALLER_IP).send(body);
const totpRows = async (id = ADMIN) => (await pool.query(`SELECT 1 FROM user_totp WHERE user_id = $1`, [id])).rowCount;
const codeRows = async (id = ADMIN) => (await pool.query(`SELECT 1 FROM user_recovery_codes WHERE user_id = $1`, [id])).rowCount;
async function audit(actionType: string) {
  return (await pool.query(`SELECT ip_address, metadata FROM platform_audit_logs WHERE action_type = $1 ORDER BY created_at`, [actionType])).rows;
}

beforeEach(async () => {
  await seed();
  await addAdmin(ADMIN, ADMIN_EMAIL, false);
  await addAdmin(ROOT, ROOT_EMAIL, false);
  ({ secret, codes } = await enrol(ADMIN));
  jest.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('what it takes', () => {
  it('a session alone is not enough: the body must carry the password and a proof', async () => {
    for (const body of [{}, { password: 'the-right-password' }, { code: totp(secret, now()) }]) {
      const res = await disable(body as Record<string, string>);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    // A code and a recovery code together is also refused: exactly one proof.
    expect((await disable({ password: 'the-right-password', code: totp(secret, now()), recovery_code: codes[0] })).status).toBe(400);
    expect(await totpRows()).toBe(1);
  });

  it('a wrong password is refused, counted, and turns nothing off', async () => {
    const res = await disable({ password: 'not-it', code: totp(secret, now()) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
    expect(lockout.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect(await totpRows()).toBe(1);
  });

  it('a wrong code is counted twice and turns nothing off', async () => {
    const res = await disable({ password: 'the-right-password', code: totp(secret, now() + 10 * TOTP_STEP_SECONDS) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
    expect((await pool.query(`SELECT failed_attempts FROM user_totp WHERE user_id = $1`, [ADMIN])).rows[0].failed_attempts).toBe(1);
    expect(lockout.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect(await totpRows()).toBe(1);
  });

  it('a wrong recovery code is counted too', async () => {
    const res = await disable({ password: 'the-right-password', recovery_code: 'AAAA-BBBB-CCCC-DDDD' });
    expect(res.status).toBe(400);
    expect((await pool.query(`SELECT failed_attempts FROM user_totp WHERE user_id = $1`, [ADMIN])).rows[0].failed_attempts).toBe(1);
    expect(await totpRows()).toBe(1);
  });

  it('is refused while the factor is locked, and when two-factor is not on', async () => {
    await pool.query(`UPDATE user_totp SET locked_until = now() + interval '10 minutes' WHERE user_id = $1`, [ADMIN]);
    expect((await disable({ password: 'the-right-password', code: totp(secret, now()) })).status).toBe(423);
    const off = await disable({ password: 'the-right-password', code: '123456' }, adminToken(ROOT, ROOT_EMAIL, { secondFactor: false }));
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('TWO_FACTOR_NOT_ON');
  });
});

describe('refused while the account is marked required', () => {
  it('refuses, turns nothing off, and spends nothing; once made optional, the same request works', async () => {
    await pool.query(`UPDATE users SET two_factor_required = true WHERE id = $1`, [ADMIN]);
    const res = await disable({ password: 'the-right-password', code: totp(secret, now()) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TWO_FACTOR_REQUIRED_FOR_ACCOUNT');
    expect(await totpRows()).toBe(1);
    expect(await codeRows()).toBe(10);
    expect(lockout.recordFailedAttempt).not.toHaveBeenCalled();

    // The control: the requirement lifted, the same request turns it off.
    await pool.query(`UPDATE users SET two_factor_required = false WHERE id = $1`, [ADMIN]);
    expect((await disable({ password: 'the-right-password', code: totp(secret, now()) })).status).toBe(200);
  });

  it('the transaction re-checks under the row lock: required set after the route checked still refuses', async () => {
    await pool.query(`UPDATE users SET two_factor_required = true WHERE id = $1`, [ADMIN]);
    expect(await disableTwoFactor(ADMIN, 'totp', null)).toBe('required');
    expect(await totpRows()).toBe(1);
    expect(await audit('TWO_FACTOR_DISABLED')).toHaveLength(0);
    // The control: not required, the same call turns it off.
    await pool.query(`UPDATE users SET two_factor_required = false WHERE id = $1`, [ADMIN]);
    expect(await disableTwoFactor(ADMIN, 'totp', null)).toBe('disabled');
  });

  it('the root admin turns their own requirement off first, then two-factor: two steps, both recorded', async () => {
    const root = await enrol(ROOT);
    const rootToken = adminToken(ROOT, ROOT_EMAIL);
    expect((await request(app()).put(`${SETUP}/required`).set('Authorization', rootToken).send({ required: true })).status).toBe(200);
    expect((await disable({ password: 'the-right-password', code: totp(root.secret, now()) }, rootToken)).status).toBe(409);
    expect((await request(app()).put(`${SETUP}/required`).set('Authorization', rootToken).send({ required: false })).status).toBe(200);
    expect((await disable({ password: 'the-right-password', code: totp(root.secret, now() + TOTP_STEP_SECONDS) }, rootToken)).status).toBe(200);
    expect((await audit('TWO_FACTOR_REQUIREMENT_SET')).map((r) => r.metadata.required)).toEqual([true, false]);
    expect(await audit('TWO_FACTOR_DISABLED')).toHaveLength(1);
  });
});

describe('turning it off', () => {
  it('removes the secret, a waiting phone move and every recovery code; ends other sessions; records the previous state', async () => {
    await savePendingDeviceMove(ADMIN, generateTotpSecret());
    await pool.query(
      `INSERT INTO support_sessions (platform_admin_id, school_id, impersonated_user_id, reason, actions_taken)
       VALUES ($1, $2, $3, 'probe', '[]')`, [ADMIN, IDS.schoolA, IDS.principalA]);
    const before = adminToken(ADMIN, ADMIN_EMAIL, { ageSeconds: 60 });
    expect((await request(app()).get('/api/super-admin/admins').set('Authorization', before)).status).toBe(200);
    expect(await codeRows()).toBe(10);

    const res = await disable({ password: 'the-right-password', code: totp(secret, now()) });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    expect(await totpRows()).toBe(0); // the secret and the waiting move, one row
    expect(await codeRows()).toBe(0);
    expect(await isTwoFactorActive(ADMIN)).toBe(false);

    // This session carries on, on a token with no second factor recorded, because there is none.
    expect(jwt.decode(res.body.data.access_token)).not.toHaveProperty('second_factor');
    expect((await request(app()).get('/api/super-admin/admins').set('Authorization', 'Bearer ' + res.body.data.access_token)).status).toBe(200);
    const old = await request(app()).get('/api/super-admin/admins').set('Authorization', before);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('SESSION_ENDED');
    expect((await pool.query(`SELECT 1 FROM support_sessions WHERE platform_admin_id = $1 AND ended_at IS NULL`, [ADMIN])).rowCount).toBe(0);

    const rows = await audit('TWO_FACTOR_DISABLED');
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_address).toBe(CALLER_IP);
    expect(rows[0].metadata).toMatchObject({ unused_recovery_codes: 10, proof: 'totp' });
    expect(rows[0].metadata.enabled_at).toBeTruthy();
    // Migration 055's trigger records the removal of an active factor too.
    expect(await audit('TWO_FACTOR_REMOVED')).toHaveLength(1);
  });

  it('a recovery code works as the proof, is spent, and is recorded as the proof', async () => {
    const res = await disable({ password: 'the-right-password', recovery_code: codes[3] });
    expect(res.status).toBe(200);
    expect(await totpRows()).toBe(0);
    const rows = await audit('TWO_FACTOR_DISABLED');
    expect(rows[0].metadata).toMatchObject({ proof: 'recovery_code', unused_recovery_codes: 9 });
  });

  it('afterwards, signing in needs only the password, and it can be switched back on from scratch', async () => {
    // The control: with it on, the password alone gets a challenge, not a token.
    const challenged = await request(app()).post('/api/auth/login').set('X-Real-IP', CALLER_IP)
      .send({ email: ADMIN_EMAIL, password: 'the-right-password' });
    expect(challenged.body.data).toMatchObject({ two_factor_required: true });

    expect((await disable({ password: 'the-right-password', code: totp(secret, now()) })).status).toBe(200);
    const signedIn = await request(app()).post('/api/auth/login').set('X-Real-IP', CALLER_IP)
      .send({ email: ADMIN_EMAIL, password: 'the-right-password' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.access_token).toBeTruthy();
    expect(signedIn.body.data.two_factor_required).toBeUndefined();

    // Switching it back on starts fresh: a new secret, and the old recovery codes are gone for good.
    const fresh = 'Bearer ' + signedIn.body.data.access_token;
    const start = await request(app()).post(`${SETUP}/enrolment`).set('Authorization', fresh).send({ password: 'the-right-password' });
    expect(start.status).toBe(200);
    expect(start.body.data.secret).not.toBe('');
    expect(await codeRows()).toBe(0);
  });
});
