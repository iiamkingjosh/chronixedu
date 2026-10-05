/**
 * A password cannot be reused within 60 days (Moses, 5 Oct 2026; migration 060), on the two paths a
 * person sets their own: POST /api/auth/change-password and POST /api/auth/confirm-reset. Also here,
 * from the same day:
 *  - confirm-reset writes our hash and Supabase's in one transaction (it used two separate steps);
 *  - a reset whose sessions Supabase has already ended is not alarmed (CHRONIXEDU-API-5);
 *  - a platform admin's reset or change is recorded (it was not, anywhere);
 *  - a wrong current password answers 400, not the 401 that signed the person out.
 *
 * Supabase Auth is not reachable from the DB suite, so its client is a stand-in that records calls,
 * and the reset link's own checks (services/resetLink.ts, tested on their own) pass. Everything else
 * is real. Every refusal is shown beside the same request succeeding (doctrine 16).
 */
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: {
    auth: {
      getUser: jest.fn(),
      admin: { updateUserById: jest.fn(), signOut: jest.fn() },
    },
  },
}));
jest.mock('../services/resetLink', () => ({ judgeResetToken: jest.fn(() => ({ ok: true })) }));

import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { AuthSessionMissingError, AuthApiError } from '@supabase/supabase-js';
import { pool, seed, IDS, token } from './helpers';
import authRoutes from '../routes/auth';
import { errorHandler } from '../middleware/errorHandler';
import { logger } from '../config/logger';
import { PASSWORD_REUSE_DAYS } from '../services/passwordReuse';
import { runPasswordHistoryRetention } from '../services/passwordHistoryRetention';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { supabaseAdmin } = require('../supabaseClient');
const updateUserById = supabaseAdmin.auth.admin.updateUserById as jest.Mock;
const signOut = supabaseAdmin.auth.admin.signOut as jest.Mock;
const getUser = supabaseAdmin.auth.getUser as jest.Mock;

const TEACHER = IDS.mathTeacher;
const TEACHER_EMAIL = `${IDS.mathTeacher}@test`;
const ADMIN = 'c0a70000-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'resetter@chronix.test';
const CALLER_IP = '102.89.44.217';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRoutes);
  a.use(errorHandler);
  return a;
}

const change = (current: string, next: string, t = token(TEACHER, 'teacher', IDS.schoolA)) =>
  request(app()).post('/api/auth/change-password').set('Authorization', t).set('X-Real-IP', CALLER_IP)
    .send({ current_password: current, new_password: next });

/** A reset as Supabase hands it over: the link's session belongs to `email`. */
function reset(email: string, password: string) {
  getUser.mockResolvedValueOnce({ data: { user: { id: email === ADMIN_EMAIL ? ADMIN : TEACHER, email } }, error: null });
  return request(app()).post('/api/auth/confirm-reset').set('X-Real-IP', CALLER_IP)
    .send({ password, confirm_password: password, access_token: 'a-reset-link-session' });
}

const hashOf = async (id = TEACHER) => (await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [id])).rows[0].password_hash as string;
const history = async (id = TEACHER) =>
  (await pool.query(`SELECT password_hash, retired_at FROM password_history WHERE user_id = $1 ORDER BY retired_at`, [id])).rows;
async function setPassword(password: string, id = TEACHER) {
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, await bcrypt.hash(password, 4)]);
}
async function retiredDaysAgo(password: string, days: number, id = TEACHER) {
  await pool.query(
    `INSERT INTO password_history (user_id, password_hash, retired_at) VALUES ($1, $2, now() - make_interval(days => $3))`,
    [id, await bcrypt.hash(password, 4), days]
  );
}

beforeEach(async () => {
  await seed();
  await setPassword('first-password');
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password, two_factor_required)
     VALUES ($1, NULL, $2, '', 'super_admin', 'Platform', 'Admin', true, false, false)`,
    [ADMIN, ADMIN_EMAIL]
  );
  jest.clearAllMocks();
  updateUserById.mockResolvedValue({ data: {}, error: null });
  signOut.mockResolvedValue({ data: null, error: null });
});

afterAll(async () => {
  await pool.end();
});

describe('Change password: the reuse rule', () => {
  it('a new password is accepted, and the one it replaced is kept for the rule (the control)', async () => {
    const before = await hashOf();
    const res = await change('first-password', 'second-password');
    expect(res.status).toBe(200);
    expect(await bcrypt.compare('second-password', await hashOf())).toBe(true);
    expect(updateUserById).toHaveBeenCalledWith(TEACHER, { password: 'second-password' });
    expect((await history()).map(r => r.password_hash)).toEqual([before]);
  });

  it('going back to the password just replaced is refused, and nothing changes', async () => {
    expect((await change('first-password', 'second-password')).status).toBe(200);
    jest.clearAllMocks();
    const hash = await hashOf();

    const res = await change('second-password', 'first-password');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'PASSWORD_RECENTLY_USED',
      message: 'You used this password in the last 2 months. Choose a different one.',
    });
    expect(await hashOf()).toBe(hash);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(await history()).toHaveLength(1);
  });

  it(`a password replaced ${PASSWORD_REUSE_DAYS - 1} days ago is refused; one replaced ${PASSWORD_REUSE_DAYS + 1} days ago is allowed`, async () => {
    await retiredDaysAgo('inside-window', PASSWORD_REUSE_DAYS - 1);
    await retiredDaysAgo('outside-window', PASSWORD_REUSE_DAYS + 1);
    expect((await change('first-password', 'inside-window')).body.error?.code).toBe('PASSWORD_RECENTLY_USED');
    const res = await change('first-password', 'outside-window');
    expect(res.status).toBe(200);
    expect(await bcrypt.compare('outside-window', await hashOf())).toBe(true);
  });

  it('a change drops the account\'s rows past the window and keeps those inside it', async () => {
    await retiredDaysAgo('old-one', PASSWORD_REUSE_DAYS + 5);
    await retiredDaysAgo('recent-one', 10);
    expect(await history()).toHaveLength(2);
    expect((await change('first-password', 'second-password')).status).toBe(200);
    const kept = await history();
    expect(kept).toHaveLength(2);
    expect(await bcrypt.compare('recent-one', kept[0].password_hash)).toBe(true);
    expect(await bcrypt.compare('first-password', kept[1].password_hash)).toBe(true);
  });

  it('a wrong current password answers 400, never the 401 that signs a person out, and changes nothing', async () => {
    const hash = await hashOf();
    const res = await change('not-it', 'second-password');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(await hashOf()).toBe(hash);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('if Supabase refuses, our hash and the history are rolled back with it', async () => {
    const hash = await hashOf();
    updateUserById.mockResolvedValueOnce({ data: null, error: { message: 'Supabase said no' } });
    const res = await change('first-password', 'second-password');
    expect(res.status).toBe(500);
    expect(await hashOf()).toBe(hash);
    expect(await history()).toHaveLength(0);
    // The control: the same change, accepted, writes both.
    expect((await change('first-password', 'second-password')).status).toBe(200);
    expect(await history()).toHaveLength(1);
  });
});

describe('Forgot password (confirm-reset): the same rule, in one transaction', () => {
  it('a new password resets, our hash and Supabase\'s together, and the old one is kept (the control)', async () => {
    const before = await hashOf();
    const res = await reset(TEACHER_EMAIL, 'second-password');
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(TEACHER, { password: 'second-password' });
    expect(await bcrypt.compare('second-password', await hashOf())).toBe(true);
    expect((await history()).map(r => r.password_hash)).toEqual([before]);
    expect(signOut).toHaveBeenCalledWith('a-reset-link-session', 'global');
  });

  it('resetting to the current password is refused before Supabase is asked, and the link is not used up', async () => {
    const hash = await hashOf();
    const res = await reset(TEACHER_EMAIL, 'first-password');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_RECENTLY_USED');
    expect(typeof res.body.error.message).toBe('string');
    expect(updateUserById).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(await hashOf()).toBe(hash);
    // The same link then works with a password the account has not used.
    expect((await reset(TEACHER_EMAIL, 'second-password')).status).toBe(200);
  });

  it('a password replaced within the window is refused on a reset too', async () => {
    await retiredDaysAgo('used-last-month', 30);
    expect((await reset(TEACHER_EMAIL, 'used-last-month')).body.error?.code).toBe('PASSWORD_RECENTLY_USED');
    expect((await reset(TEACHER_EMAIL, 'never-used')).status).toBe(200);
  });

  it('if Supabase refuses, nothing of ours changes: the two stores can no longer disagree', async () => {
    const hash = await hashOf();
    updateUserById.mockResolvedValueOnce({ data: null, error: { message: 'Password is too weak' } });
    const res = await reset(TEACHER_EMAIL, 'second-password');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'PASSWORD_UPDATE_FAILED', message: 'Password is too weak' });
    expect(await hashOf()).toBe(hash);
    expect(await history()).toHaveLength(0);
  });

  it('an account created with no password gets one, and leaves no empty entry behind', async () => {
    expect(await hashOf(ADMIN)).toBe('');
    expect((await reset(ADMIN_EMAIL, 'admin-first-password')).status).toBe(200);
    expect(await bcrypt.compare('admin-first-password', await hashOf(ADMIN))).toBe(true);
    expect(await history(ADMIN)).toHaveLength(0);
  });
});

describe('a reset whose Supabase sessions are already gone (CHRONIXEDU-API-5)', () => {
  it('a sign-out that finds the session missing is logged as done, not alerted', async () => {
    signOut.mockResolvedValueOnce({ data: null, error: new AuthSessionMissingError() });
    const error = jest.spyOn(logger, 'error');
    const info = jest.spyOn(logger, 'info');
    expect((await reset(TEACHER_EMAIL, 'second-password')).status).toBe(200);
    expect(info).toHaveBeenCalledWith('password_reset_sessions_already_ended', { user_id: TEACHER });
    expect(error).not.toHaveBeenCalledWith('password_reset_sessions_not_revoked', expect.anything());
    error.mockRestore(); info.mockRestore();
  });

  it('any other sign-out failure still alerts (the control)', async () => {
    signOut.mockResolvedValueOnce({ data: null, error: new AuthApiError('upstream timeout', 504, 'unexpected_failure') });
    const error = jest.spyOn(logger, 'error');
    expect((await reset(TEACHER_EMAIL, 'second-password')).status).toBe(200);
    expect(error).toHaveBeenCalledWith('password_reset_sessions_not_revoked', { user_id: TEACHER, error: 'upstream timeout' });
    error.mockRestore();
  });
});

describe('who set their own password is recorded, school user or platform admin', () => {
  const schoolRows = async (action: string) =>
    (await pool.query(`SELECT user_id, ip_address FROM audit_logs WHERE action_type = $1`, [action])).rows;
  const platformRows = async (action: string) =>
    (await pool.query(`SELECT platform_admin_id, target_user_id, ip_address FROM platform_audit_logs WHERE action_type = $1`, [action])).rows;

  it('a school user\'s reset goes to the school\'s audit log (the control)', async () => {
    expect((await reset(TEACHER_EMAIL, 'second-password')).status).toBe(200);
    expect(await schoolRows('PASSWORD_RESET_COMPLETE')).toEqual([{ user_id: TEACHER, ip_address: CALLER_IP }]);
    expect(await platformRows('PASSWORD_RESET_COMPLETE')).toEqual([]);
  });

  it('a platform admin\'s reset, which recorded nothing, goes to the platform audit log', async () => {
    expect((await reset(ADMIN_EMAIL, 'admin-first-password')).status).toBe(200);
    expect(await platformRows('PASSWORD_RESET_COMPLETE')).toEqual([{ platform_admin_id: ADMIN, target_user_id: ADMIN, ip_address: CALLER_IP }]);
  });

  it('a platform admin\'s own change of password is recorded there too', async () => {
    await setPassword('admin-first-password', ADMIN);
    const adminToken = token(ADMIN, 'super_admin', null as unknown as string);
    expect((await change('admin-first-password', 'admin-second-password', adminToken)).status).toBe(200);
    expect(await platformRows('PASSWORD_SELF_CHANGE')).toEqual([{ platform_admin_id: ADMIN, target_user_id: ADMIN, ip_address: CALLER_IP }]);
  });
});

describe('what is kept, and for how long', () => {
  it('the daily job deletes every row past the window and none inside it', async () => {
    await retiredDaysAgo('old-one', PASSWORD_REUSE_DAYS + 1);
    await retiredDaysAgo('recent-one', PASSWORD_REUSE_DAYS - 1);
    expect(await runPasswordHistoryRetention()).toBe(1);
    const left = await history();
    expect(left).toHaveLength(1);
    expect(await bcrypt.compare('recent-one', left[0].password_hash)).toBe(true);
  });

  it('only a bcrypt hash can be stored', async () => {
    await expect(pool.query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1, 'plaintext')`, [TEACHER]))
      .rejects.toThrow(/password_history_password_hash_check/);
  });

  it("gives Supabase's REST roles nothing, although an ordinary table gives them everything", async () => {
    const { rows } = await pool.query<{ tbl: string; role: string; granted: boolean }>(
      `SELECT t AS tbl, r AS role,
              has_table_privilege(r, t, 'SELECT') OR has_table_privilege(r, t, 'INSERT')
           OR has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE') AS granted
         FROM unnest(ARRAY['users', 'password_history']) AS t, unnest(ARRAY['anon', 'authenticated']) AS r`
    );
    expect(Object.fromEntries(rows.map(r => [`${r.tbl} ${r.role}`, r.granted]))).toEqual({
      'password_history anon': false,
      'password_history authenticated': false,
      'users anon': true,
      'users authenticated': true,
    });
  });
});
