/**
 * Platform-admin two-factor, commit 5: moving to a new phone while the old one works (migration 059),
 * and the requirement setting (PUT /required, migration 058's column).
 *
 * Supabase Auth is not reachable from the DB suite, so the password check is a stand-in that accepts
 * one password, and the sign-in lockout (Redis) is a spy, so the test can say what it was asked to
 * count. Everything else is real: the factor's columns and counters, the sessions cut-off, the support
 * sessions and the audit rows. Every refusal is shown beside the same request succeeding (doctrine 16).
 */
jest.mock('../services/passwordCheck', () => ({
  passwordMatches: jest.fn(async (_email: string, password: string) => password === 'the-right-password'),
}));
jest.mock('../services/loginLockout', () => ({
  isLockedOut: jest.fn(async () => false),
  recordFailedAttempt: jest.fn(async () => ({ counted: true, locked: false })),
  clearFailedAttempts: jest.fn(async () => undefined),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { pool, seed, IDS } from './helpers';
import twoFactorRoutes from '../routes/twoFactor';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { totp, base32Decode, generateTotpSecret, TOTP_STEP_SECONDS } from '../services/totp';
import { generateRecoveryCodes } from '../services/recoveryCodes';
import {
  savePendingTotpSecret, replaceRecoveryCodes, readTotpSecret, readPendingDeviceMove, savePendingDeviceMove,
  completeDeviceMove, consumeRecoveryCode, unusedRecoveryCodeCount,
} from '../db/queries/twoFactorStore';
import * as lockout from '../services/loginLockout';

const ADMIN = 'c0a50000-0000-4000-8000-000000000001'; // two-factor on, existed before 058
const PLAIN = 'c0a50000-0000-4000-8000-000000000002'; // two-factor off, existed before 058
const NEW = 'c0a50000-0000-4000-8000-000000000003'; // created since 058: required, not yet set up
const ROOT = 'c0a50000-0000-4000-8000-000000000004'; // the root admin, two-factor off
const ADMIN_EMAIL = 'mover@chronix.test';
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL!;
const CALLER_IP = '102.89.44.217';
const SETUP = '/api/super-admin/two-factor';

function app() {
  const a = express();
  a.use(express.json());
  a.use(SETUP, twoFactorRoutes);
  a.use('/api/super-admin', superAdminRoutes);
  a.use(errorHandler);
  return a;
}

/** A platform admin's token. By default issued a second from now, and recording the second factor. */
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
}

const now = () => Date.now() / 1000;
let oldSecret: Buffer;
let recoveryCodes: string[];

const start = (code = totp(oldSecret, now()), password = 'the-right-password', t = token()) =>
  request(app()).post(`${SETUP}/device-move`).set('Authorization', t).set('X-Real-IP', CALLER_IP).send({ password, code });
const confirm = (code: string, t = token()) =>
  request(app()).post(`${SETUP}/device-move/confirm`).set('Authorization', t).set('X-Real-IP', CALLER_IP).send({ code });

async function audit(actionType: string) {
  return (await pool.query(`SELECT ip_address, metadata FROM platform_audit_logs WHERE action_type = $1 ORDER BY created_at`, [actionType])).rows;
}
async function pendingRow() {
  return (await pool.query(`SELECT pending_secret_ciphertext, pending_created_at, failed_attempts FROM user_totp WHERE user_id = $1`, [ADMIN])).rows[0];
}

beforeEach(async () => {
  await seed();
  await addAdmin(ADMIN, ADMIN_EMAIL, false);
  await addAdmin(PLAIN, 'plain@chronix.test', false);
  await addAdmin(NEW, 'new@chronix.test', true);
  await addAdmin(ROOT, ROOT_EMAIL, false);
  oldSecret = generateTotpSecret();
  recoveryCodes = generateRecoveryCodes();
  await savePendingTotpSecret(ADMIN, oldSecret);
  await pool.query(`UPDATE user_totp SET activated_at = now() WHERE user_id = $1`, [ADMIN]);
  await replaceRecoveryCodes(ADMIN, recoveryCodes);
  jest.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('starting a move', () => {
  it('needs the password: a wrong one is refused, counted, and starts nothing', async () => {
    const res = await start(totp(oldSecret, now()), 'not-it');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
    expect(lockout.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect((await pendingRow()).pending_secret_ciphertext).toBeNull();
  });

  it('needs a current code from the old phone: a wrong one is counted twice and starts nothing', async () => {
    const res = await start(totp(oldSecret, now() + 10 * TOTP_STEP_SECONDS));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
    expect((await pendingRow()).failed_attempts).toBe(1);
    expect(lockout.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect((await pendingRow()).pending_secret_ciphertext).toBeNull();
  });

  it('with both, returns the new secret once, marked not to be stored, and leaves the working one in place', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.data.otpauth_uri).toContain(`secret=${res.body.data.secret}`);
    expect(res.body.data.expires_in).toBe(15 * 60);

    // The working secret is unchanged, and the new one waits beside it, encrypted.
    expect((await readTotpSecret(ADMIN))!.secret.equals(oldSecret)).toBe(true);
    const pending = await readPendingDeviceMove(ADMIN);
    expect(pending!.secret.equals(base32Decode(res.body.data.secret))).toBe(true);
    expect(pending!.ciphertext.includes(pending!.secret)).toBe(false);

    const started = await audit('TWO_FACTOR_DEVICE_MOVE_STARTED');
    expect(started).toHaveLength(1);
    expect(started[0].ip_address).toBe(CALLER_IP);
    expect(JSON.stringify(started)).not.toContain(res.body.data.secret);
  });

  it('the code that started it is used up', async () => {
    const code = totp(oldSecret, now());
    expect((await start(code)).status).toBe(200);
    const again = await start(code);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_CODE');
  });

  it('is refused when two-factor is not on, and the database refuses a pending secret beside no active one', async () => {
    const res = await start('123456', 'the-right-password', adminToken(PLAIN, 'plain@chronix.test'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TWO_FACTOR_NOT_ON');

    await savePendingTotpSecret(PLAIN, generateTotpSecret()); // enrolment started, not finished
    await expect(pool.query(
      `UPDATE user_totp SET pending_secret_ciphertext = '\\x01'::bytea, pending_created_at = now() WHERE user_id = $1`, [PLAIN]))
      .rejects.toThrow(/user_totp_pending_needs_active/);
    // The control: the same write beside an active factor is accepted.
    await expect(pool.query(
      `UPDATE user_totp SET pending_secret_ciphertext = '\\x01'::bytea, pending_created_at = now() WHERE user_id = $1`, [ADMIN]))
      .resolves.toBeDefined();
    await expect(pool.query(`UPDATE user_totp SET pending_created_at = NULL WHERE user_id = $1`, [ADMIN]))
      .rejects.toThrow(/user_totp_pending_whole/);
  });

  it('is refused while the factor is locked, on both steps', async () => {
    await pool.query(`UPDATE user_totp SET locked_until = now() + interval '10 minutes' WHERE user_id = $1`, [ADMIN]);
    expect((await start()).status).toBe(423);
    expect((await confirm('123456')).status).toBe(423);
  });
});

describe('finishing a move', () => {
  it('until it is confirmed, the old phone keeps working', async () => {
    expect((await start(totp(oldSecret, now()))).status).toBe(200);
    // A later step of the OLD phone still passes a code check (new recovery codes need one).
    const res = await request(app()).post(`${SETUP}/recovery-codes`).set('Authorization', token())
      .send({ code: totp(oldSecret, now() + TOTP_STEP_SECONDS) });
    expect(res.status).toBe(200);
    expect(await readPendingDeviceMove(ADMIN)).not.toBeNull();
  });

  it('a code from the new phone switches over: old codes stop, new ones work, other sessions end, recovery codes stay', async () => {
    await pool.query(
      `INSERT INTO support_sessions (platform_admin_id, school_id, impersonated_user_id, reason, actions_taken)
       VALUES ($1, $2, $3, 'probe', '[]')`,
      [ADMIN, IDS.schoolA, IDS.principalA]
    );
    const before = adminToken(ADMIN, ADMIN_EMAIL, { ageSeconds: 60 });
    expect((await request(app()).get('/api/super-admin/admins').set('Authorization', before)).status).toBe(200);

    const started = await start(totp(oldSecret, now()));
    const newSecret = base32Decode(started.body.data.secret);
    const res = await confirm(totp(newSecret, now()));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    // The new phone is the factor now, and nothing waits.
    expect((await readTotpSecret(ADMIN))!.secret.equals(newSecret)).toBe(true);
    expect((await pendingRow()).pending_secret_ciphertext).toBeNull();

    // The returned token records the factor and works; a session from before the move has ended.
    const fresh = 'Bearer ' + res.body.data.access_token;
    expect(jwt.decode(res.body.data.access_token)).toMatchObject({ second_factor: 'totp' });
    expect((await request(app()).get('/api/super-admin/admins').set('Authorization', fresh)).status).toBe(200);
    const old = await request(app()).get('/api/super-admin/admins').set('Authorization', before);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('SESSION_ENDED');
    expect((await pool.query(`SELECT 1 FROM support_sessions WHERE platform_admin_id = $1 AND ended_at IS NULL`, [ADMIN])).rowCount).toBe(0);

    // The recovery codes are the same set: all ten left, and one of them still works.
    expect(await unusedRecoveryCodeCount(ADMIN)).toBe(10);
    expect(await consumeRecoveryCode(ADMIN, recoveryCodes[0])).toBe(true);

    const moved = await audit('TWO_FACTOR_DEVICE_MOVED');
    expect(moved).toHaveLength(1);
    expect(moved[0].ip_address).toBe(CALLER_IP);
    expect(moved[0].metadata).toEqual({ recovery_codes_kept: true });

    // The old phone's next code is refused; the new phone's next code is accepted.
    const viaOld = await request(app()).post(`${SETUP}/recovery-codes`).set('Authorization', fresh)
      .send({ code: totp(oldSecret, now() + TOTP_STEP_SECONDS) });
    expect(viaOld.status).toBe(400);
    const viaNew = await request(app()).post(`${SETUP}/recovery-codes`).set('Authorization', fresh)
      .send({ code: totp(newSecret, now() + TOTP_STEP_SECONDS) });
    expect(viaNew.status).toBe(200);
  });

  it('a code from the OLD phone does not confirm: counted as wrong, and nothing switches', async () => {
    await start(totp(oldSecret, now()));
    const res = await confirm(totp(oldSecret, now() + TOTP_STEP_SECONDS));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CODE');
    expect((await pendingRow()).failed_attempts).toBe(1);
    expect(lockout.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect((await readTotpSecret(ADMIN))!.secret.equals(oldSecret)).toBe(true);
    expect(await readPendingDeviceMove(ADMIN)).not.toBeNull();
  });

  it('a move waits 15 minutes and no longer', async () => {
    const started = await start(totp(oldSecret, now()));
    const newSecret = base32Decode(started.body.data.secret);
    await pool.query(`UPDATE user_totp SET pending_created_at = now() - interval '16 minutes' WHERE user_id = $1`, [ADMIN]);
    const res = await confirm(totp(newSecret, now()));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_MOVE_NOT_STARTED');
    expect((await readTotpSecret(ADMIN))!.secret.equals(oldSecret)).toBe(true);

    // The control: the same confirmation inside the 15 minutes switches.
    await pool.query(`UPDATE user_totp SET pending_created_at = now() - interval '14 minutes' WHERE user_id = $1`, [ADMIN]);
    expect((await confirm(totp(newSecret, now()))).status).toBe(200);
  });

  it('starting again replaces the waiting secret: only the latest one confirms', async () => {
    const first = base32Decode((await start(totp(oldSecret, now()))).body.data.secret);
    const second = base32Decode((await start(totp(oldSecret, now() + TOTP_STEP_SECONDS))).body.data.secret);
    expect((await confirm(totp(first, now()))).status).toBe(400);
    expect((await confirm(totp(second, now()))).status).toBe(200);
    expect((await readTotpSecret(ADMIN))!.secret.equals(second)).toBe(true);
  });

  it('switches to exactly the secret whose code was checked, never one started again in between', async () => {
    await savePendingDeviceMove(ADMIN, generateTotpSecret());
    const checked = await readPendingDeviceMove(ADMIN);
    await savePendingDeviceMove(ADMIN, generateTotpSecret()); // another tab starts again
    const auditEntry = { adminId: ADMIN, actionType: 'TWO_FACTOR_DEVICE_MOVED', targetUserId: ADMIN, ipAddress: null };
    expect(await completeDeviceMove(ADMIN, checked!.ciphertext, 1, auditEntry)).toBe(false);
    expect((await readTotpSecret(ADMIN))!.secret.equals(oldSecret)).toBe(true);
    expect(await audit('TWO_FACTOR_DEVICE_MOVED')).toHaveLength(0);

    // The control: the bytes that are actually waiting do switch.
    const current = await readPendingDeviceMove(ADMIN);
    expect(await completeDeviceMove(ADMIN, current!.ciphertext, 1, auditEntry)).toBe(true);
    expect((await readTotpSecret(ADMIN))!.secret.equals(current!.secret)).toBe(true);
  });

  it('confirming with nothing started is refused', async () => {
    const res = await confirm('123456');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_MOVE_NOT_STARTED');
  });
});

describe('making two-factor required for your own account', () => {
  const setRequired = (required: boolean, t: string) =>
    request(app()).put(`${SETUP}/required`).set('Authorization', t).set('X-Real-IP', CALLER_IP).send({ required });
  const requiredOf = async (id: string) =>
    (await pool.query(`SELECT two_factor_required FROM users WHERE id = $1`, [id])).rows[0].two_factor_required;

  it('any admin may make it required for themselves: audited with the previous value, and shown on the Admins list', async () => {
    const res = await setRequired(true, token());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ required: true, previous: false, changed: true });
    expect(await requiredOf(ADMIN)).toBe(true);
    const rows = await audit('TWO_FACTOR_REQUIREMENT_SET');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip_address: CALLER_IP, metadata: { previous: false, required: true } });

    const list = await request(app()).get('/api/super-admin/admins').set('Authorization', adminToken(ROOT, ROOT_EMAIL, { secondFactor: false }));
    const me = list.body.data.find((a: { id: string }) => a.id === ADMIN);
    expect(me).toMatchObject({ two_factor_on: true, two_factor_required: true });
  });

  it('saving the same value again changes nothing and writes no audit row', async () => {
    await setRequired(true, token());
    const again = await setRequired(true, token());
    expect(again.body.data).toEqual({ required: true, previous: true, changed: false });
    expect(await audit('TWO_FACTOR_REQUIREMENT_SET')).toHaveLength(1);
  });

  it('only the root admin may make it optional again, and that is audited too', async () => {
    await setRequired(true, token());
    const refused = await setRequired(false, token());
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ROOT_ADMIN_REQUIRED');
    expect(await requiredOf(ADMIN)).toBe(true);

    // The control: the root admin, with two-factor on, turns their own on and then off.
    await savePendingTotpSecret(ROOT, generateTotpSecret());
    await pool.query(`UPDATE user_totp SET activated_at = now() WHERE user_id = $1`, [ROOT]);
    const rootToken = adminToken(ROOT, ROOT_EMAIL);
    expect((await setRequired(true, rootToken)).status).toBe(200);
    const off = await setRequired(false, rootToken);
    expect(off.status).toBe(200);
    expect(off.body.data).toEqual({ required: false, previous: true, changed: true });
    expect(await requiredOf(ROOT)).toBe(false);

    // Both directions are recorded, each with the value it replaced.
    const rows = await audit('TWO_FACTOR_REQUIREMENT_SET');
    expect(rows.map((r) => r.metadata)).toEqual([
      { previous: false, required: true },  // ADMIN on
      { previous: false, required: true },  // ROOT on
      { previous: true, required: false },  // ROOT off
    ]);
  });

  it('an admin without two-factor who makes it required is confined to the setup routes at once', async () => {
    const plain = adminToken(PLAIN, 'plain@chronix.test', { secondFactor: false });
    expect((await request(app()).get('/api/super-admin/admins').set('Authorization', plain)).status).toBe(200);
    expect((await setRequired(true, plain)).status).toBe(200);
    const after = await request(app()).get('/api/super-admin/admins').set('Authorization', plain);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    expect((await request(app()).get(`${SETUP}/status`).set('Authorization', plain)).body.data)
      .toMatchObject({ required: true, enabled: false });
  });

  it('a required admin who has not set up cannot reach the setting, so cannot switch the requirement off', async () => {
    const res = await setRequired(false, adminToken(NEW, 'new@chronix.test', { secondFactor: false }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    expect(await requiredOf(NEW)).toBe(true);
  });

  it('the status says who may make it optional', async () => {
    const mine = await request(app()).get(`${SETUP}/status`).set('Authorization', token());
    expect(mine.body.data.may_make_optional).toBe(false);
    const root = await request(app()).get(`${SETUP}/status`).set('Authorization', adminToken(ROOT, ROOT_EMAIL, { secondFactor: false }));
    expect(root.body.data.may_make_optional).toBe(true);
  });
});
