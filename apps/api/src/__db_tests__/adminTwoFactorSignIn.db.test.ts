/**
 * Platform-admin two-factor, commit 3 of 4: the second step at sign-in (migration 057,
 * routes/auth.ts POST /login and POST /login/verify).
 *
 * Supabase Auth is not reachable from the DB suite, so the password check is replaced here by a
 * stand-in that accepts one password; the sign-in lockout (Redis) and the email sender are replaced
 * by spies, so the test can say what each was asked to do. Everything else is real: the login
 * connection, the challenge table, the factor's counters and the audit rows.
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
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => 'sent') }));

import express from 'express';
import request from 'supertest';
import { pool, seed, IDS } from './helpers';
import authRoutes from '../routes/auth';
import twoFactorRoutes from '../routes/twoFactor';
import { errorHandler } from '../middleware/errorHandler';
import { logger } from '../config/logger';
import { totp, generateTotpSecret, TOTP_STEP_SECONDS } from '../services/totp';
import { generateRecoveryCodes } from '../services/recoveryCodes';
import { savePendingTotpSecret, replaceRecoveryCodes, TOTP_LOCK_AFTER } from '../db/queries/twoFactorStore';
import { CHALLENGE_MAX_ATTEMPTS } from '../db/queries/loginChallenges';
import * as lockout from '../services/loginLockout';
import * as email from '../services/emailService';

const ENROLLED = 'c0a30000-0000-4000-8000-000000000001';
const PLAIN = 'c0a30000-0000-4000-8000-000000000002';
const ENROLLED_EMAIL = 'enrolled-admin@chronix.test';
const PLAIN_EMAIL = 'plain-admin@chronix.test';
const CALLER_IP = '102.89.83.241';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRoutes);
  a.use('/api/super-admin/two-factor', twoFactorRoutes);
  a.use(errorHandler);
  return a;
}

let secret: Buffer;
let codes: string[];
let logged: string[] = [];
const spies: jest.SpyInstance[] = [];

async function addAdmin(id: string, emailAddress: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, NULL, $2, '', 'super_admin', 'Platform', 'Admin', true, false)`,
    [id, emailAddress]
  );
  mockUserIdsByEmail[emailAddress] = id;
}

const password = (emailAddress: string) =>
  request(app()).post('/api/auth/login').set('X-Real-IP', CALLER_IP).send({ email: emailAddress, password: 'the-right-password' });
const verify = (body: Record<string, string>) =>
  request(app()).post('/api/auth/login/verify').set('X-Real-IP', CALLER_IP).send(body);
const now = () => Date.now() / 1000;
/** A code that is never valid now: ten steps away, outside the one-step window. */
const wrongCode = () => totp(secret, now() + 10 * TOTP_STEP_SECONDS);

async function newChallenge(): Promise<string> {
  const res = await password(ENROLLED_EMAIL);
  expect(res.body.data.two_factor_required).toBe(true);
  return res.body.data.challenge as string;
}

async function audit(actionType: string) {
  return (await pool.query(`SELECT ip_address, metadata FROM platform_audit_logs WHERE action_type = $1 ORDER BY created_at`, [actionType])).rows;
}

beforeEach(async () => {
  await seed();
  await addAdmin(ENROLLED, ENROLLED_EMAIL);
  await addAdmin(PLAIN, PLAIN_EMAIL);
  // The seed's addresses (`<id>@test`) are not well-formed, and the login form refuses them.
  await pool.query(`UPDATE users SET email = 'principal-a@school.test' WHERE id = $1`, [IDS.principalA]);
  mockUserIdsByEmail['principal-a@school.test'] = IDS.principalA;
  secret = generateTotpSecret();
  codes = generateRecoveryCodes();
  await savePendingTotpSecret(ENROLLED, secret);
  await pool.query(`UPDATE user_totp SET activated_at = now() WHERE user_id = $1`, [ENROLLED]);
  await replaceRecoveryCodes(ENROLLED, codes);
  jest.clearAllMocks();
  (email.sendEmail as jest.Mock).mockResolvedValue('sent');
  logged = [];
  for (const level of ['error', 'warn', 'info'] as const) {
    spies.push(jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); return logger; }) as never));
  }
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

afterAll(async () => {
  await pool.end();
});

describe('the password step', () => {
  it('signs in a school user and a platform admin who has not enrolled, as before (the control)', async () => {
    for (const who of ['principal-a@school.test', PLAIN_EMAIL]) {
      const res = await password(who);
      expect({ who, status: res.status, token: !!res.body.data.access_token, second: res.body.data.two_factor_required })
        .toEqual({ who, status: 200, token: true, second: undefined });
    }
  });

  it('gives an enrolled admin no token, only a challenge, and clears no lockout counter', async () => {
    const before = (await pool.query(`SELECT last_login_at FROM users WHERE id = $1`, [ENROLLED])).rows[0].last_login_at;
    const res = await password(ENROLLED_EMAIL);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.access_token).toBeUndefined();
    expect(res.body.data.user).toBeUndefined();
    expect(res.body.data).toMatchObject({ two_factor_required: true, expires_in: 300 });
    expect(res.body.data.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lockout.clearFailedAttempts).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT last_login_at FROM users WHERE id = $1`, [ENROLLED])).rows[0].last_login_at).toEqual(before);
    // Stored only as a hash.
    const stored = (await pool.query(`SELECT challenge_hash FROM login_challenges WHERE user_id = $1`, [ENROLLED])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].challenge_hash).not.toContain(res.body.data.challenge);
  });

  it('a challenge is not a token: the API refuses it as one', async () => {
    const challenge = await newChallenge();
    const res = await request(app()).get('/api/super-admin/two-factor/status').set('Authorization', `Bearer ${challenge}`);
    expect(res.status).toBe(401);
  });
});

describe('the code step', () => {
  it('a right code signs in, with the second-factor claim, and the step offset is logged', async () => {
    const challenge = await newChallenge();
    const res = await verify({ challenge, code: totp(secret, now()) });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.user.second_factor).toBe('totp');
    const status = await request(app()).get('/api/super-admin/two-factor/status').set('Authorization', `Bearer ${res.body.data.access_token}`);
    expect(status.status).toBe(200);
    expect(lockout.clearFailedAttempts).toHaveBeenCalledWith(ENROLLED_EMAIL, CALLER_IP);
    const accepted = logged.filter((l) => l.includes('totp_code_accepted'));
    expect(accepted).toHaveLength(1);
    expect([-1, 0, 1]).toContain(JSON.parse(accepted[0])[1].step_offset);
  });

  it('a challenge works once, and not after it expires', async () => {
    const challenge = await newChallenge();
    expect((await verify({ challenge, code: totp(secret, now()) })).status).toBe(200);
    const again = await verify({ challenge, code: totp(secret, now() + TOTP_STEP_SECONDS) });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('SIGN_IN_EXPIRED');

    const old = await newChallenge();
    await pool.query(`UPDATE login_challenges SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL`);
    const expired = await verify({ challenge: old, code: totp(secret, now() + TOTP_STEP_SECONDS) });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SIGN_IN_EXPIRED');
  });

  it('a code already used is refused on a later sign-in', async () => {
    const code = totp(secret, now());
    expect((await verify({ challenge: await newChallenge(), code })).status).toBe(200);
    const replay = await verify({ challenge: await newChallenge(), code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_CODE');
  });

  it(`a wrong code counts against the sign-in lockout, and a challenge dies after ${CHALLENGE_MAX_ATTEMPTS}`, async () => {
    const challenge = await newChallenge();
    for (let i = 1; i < CHALLENGE_MAX_ATTEMPTS; i++) {
      const r = await verify({ challenge, code: wrongCode() });
      expect({ i, code: r.body.error.code }).toEqual({ i, code: 'INVALID_CODE' });
    }
    const last = await verify({ challenge, code: wrongCode() });
    expect(last.body.error.code).toBe('SIGN_IN_EXPIRED');
    expect(lockout.recordFailedAttempt).toHaveBeenCalledTimes(CHALLENGE_MAX_ATTEMPTS);
    expect(lockout.recordFailedAttempt).toHaveBeenCalledWith(ENROLLED_EMAIL, CALLER_IP);
    // Dead now, even for the right code.
    expect((await verify({ challenge, code: totp(secret, now()) })).body.error.code).toBe('SIGN_IN_EXPIRED');
  });

  it(`${TOTP_LOCK_AFTER} wrong codes spread across three challenges lock the account, alert once, and refuse even the right code`, async () => {
    // 4 + 4 + 2: no single challenge reaches its own limit, so only a per-account counter can lock.
    let sent = 0;
    for (const perChallenge of [4, 4, 2]) {
      const challenge = await newChallenge();
      for (let i = 0; i < perChallenge; i++) {
        sent++;
        const r = await verify({ challenge, code: wrongCode() });
        const expected = sent < TOTP_LOCK_AFTER ? 401 : 423;
        expect({ sent, status: r.status }).toEqual({ sent, status: expected });
      }
    }
    expect(logged.filter((l) => l.includes('two_factor_locked'))).toHaveLength(1);
    const [locked] = await audit('TWO_FACTOR_LOCKED');
    expect(locked.metadata).toMatchObject({ failed_attempts: TOTP_LOCK_AFTER, route: 'sign-in' });
    expect(locked.ip_address).toBe(CALLER_IP);

    const right = await verify({ challenge: await newChallenge(), code: totp(secret, now()) });
    expect(right.status).toBe(423);
    expect(right.body.error.code).toBe('TWO_FACTOR_LOCKED');
  });

  it('takes a code or a recovery code, exactly one', async () => {
    const challenge = await newChallenge();
    expect((await verify({ challenge })).status).toBe(400);
    expect((await verify({ challenge, code: totp(secret, now()), recovery_code: codes[0] })).status).toBe(400);
  });
});

describe('a recovery code at sign-in', () => {
  it('works once, is audited with the address, says how many are left, and tells you whether the email went', async () => {
    const res = await verify({ challenge: await newChallenge(), recovery_code: codes[0] });
    expect(res.status).toBe(200);
    expect(res.body.data.user.second_factor).toBe('recovery_code');
    expect(res.body.data.recovery).toEqual({ recovery_codes_left: 9, notice_email: 'sent' });
    expect(email.sendEmail).toHaveBeenCalledWith(ENROLLED_EMAIL, expect.stringContaining('recovery code'), expect.stringContaining('9 recovery codes left'));
    const [used] = await audit('RECOVERY_CODE_USED');
    expect(used).toMatchObject({ ip_address: CALLER_IP, metadata: { recovery_codes_left: 9 } });

    const again = await verify({ challenge: await newChallenge(), recovery_code: codes[0] });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('INVALID_CODE');
  });

  it('reads what the email sender answered: a lost notice is said in the response and alerted', async () => {
    (email.sendEmail as jest.Mock).mockResolvedValue('lost');
    const res = await verify({ challenge: await newChallenge(), recovery_code: codes[1] });
    expect(res.status).toBe(200);
    expect(res.body.data.recovery.notice_email).toBe('lost');
    expect(logged.filter((l) => l.includes('recovery_code_notice_not_sent'))).toHaveLength(1);
  });

  it('clears the failure count, as proof of who you are', async () => {
    const challenge = await newChallenge();
    for (let i = 0; i < 3; i++) await verify({ challenge, code: wrongCode() });
    expect((await pool.query(`SELECT failed_attempts FROM user_totp WHERE user_id = $1`, [ENROLLED])).rows[0].failed_attempts).toBe(3);
    expect((await verify({ challenge, recovery_code: codes[2] })).status).toBe(200);
    expect((await pool.query(`SELECT failed_attempts FROM user_totp WHERE user_id = $1`, [ENROLLED])).rows[0].failed_attempts).toBe(0);
  });
});

describe('the challenge table', () => {
  it('keeps only live challenges: a new sign-in prunes the admin\'s spent and expired ones', async () => {
    expect((await verify({ challenge: await newChallenge(), code: totp(secret, now()) })).status).toBe(200);
    await newChallenge();
    await pool.query(`UPDATE login_challenges SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL`);
    await newChallenge();
    const rows = (await pool.query(`SELECT consumed_at, expires_at > now() AS live FROM login_challenges WHERE user_id = $1`, [ENROLLED])).rows;
    expect(rows).toEqual([{ consumed_at: null, live: true }]);
  });
});
