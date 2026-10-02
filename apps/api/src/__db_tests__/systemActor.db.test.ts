/**
 * The system account (migration 053, 2 Oct 2026; SECURITY.md Round 30 L-03).
 *
 * The trial gate signed its audit rows with `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`:
 * whichever admin Postgres returned first. Chronix High School's 8 Sep 2026 suspension is recorded
 * as done by a test fixture. Now the gate signs with a fixed system account, alarms on any run that
 * cannot find it, and that account can never be made an active admin: the database refuses, and so
 * does every admin route. Each refusal or "unchanged" below follows the same thing working on an
 * ordinary admin, or the old query shown picking someone else (doctrine 16).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { seed, IDS as I, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { runTrialExpiryCheck } from '../services/subscriptionService';
import { SYSTEM_ACTOR, SYSTEM_ACTOR_ID } from '../config/systemActor';
import { logger } from '../config/logger';

jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    updateUserById: jest.fn(async () => ({ data: {}, error: null })),
    deleteUser: jest.fn(async () => ({ data: {}, error: null })),
    createUser: jest.fn(async () => ({ data: { user: null }, error: { message: 'not used here' } })),
    generateLink: jest.fn(async () => ({ data: null, error: { message: 'not used here' } })),
  } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => true),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const { supabaseAdmin } = require('../supabaseClient');
const emailService = require('../services/emailService');
/* eslint-enable @typescript-eslint/no-var-requires */

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRoutes);
app.use(errorHandler);

const ROOT = 'c0000000-0000-4000-8000-0000000000ab';
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL!;
const OTHER = 'c0000000-0000-4000-8000-0000000000ac';
const auth = () => 'Bearer ' + jwt.sign({ user_id: ROOT, school_id: null, role: 'super_admin', email: ROOT_EMAIL }, process.env.JWT_SECRET!);

const addAdmin = (id: string, email: string, active: boolean) => pool.query(
  `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
   VALUES ($1, NULL, $2, 'x', 'super_admin', 'Some', 'Admin', $3, 'subject', false)`, [id, email, active]);
const addSystemActor = () => pool.query(
  `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
   VALUES ($1, NULL, $2, '', 'super_admin', $3, $4, false, false)`,
  [SYSTEM_ACTOR.id, SYSTEM_ACTOR.email, SYSTEM_ACTOR.firstName, SYSTEM_ACTOR.lastName]);
const systemRow = async () => (await pool.query(
  `SELECT email, first_name, last_name, is_active, role FROM users WHERE id = $1`, [SYSTEM_ACTOR_ID])).rows[0];

beforeEach(async () => {
  await seed();
  jest.clearAllMocks();
  await pool.query(`INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (80000) ON CONFLICT (id) DO NOTHING`);
});
afterAll(async () => { await pool.end(); });

/** A trial for school A whose end date was `daysAgo` days before today in Lagos. */
async function expiredTrial(daysAgo: number): Promise<string> {
  const res = await request(app).post('/api/super-admin/subscriptions').set('Authorization', auth()).send({ school_id: I.schoolA, plan: 'trial' });
  expect(res.status).toBe(201);
  await pool.query(
    `UPDATE platform_subscriptions
        SET trial_ends_at = ((date_trunc('day', NOW() AT TIME ZONE 'Africa/Lagos') - make_interval(days => $2)) AT TIME ZONE 'Africa/Lagos')
      WHERE id = $1`, [res.body.data.id, daysAgo]);
  return res.body.data.id;
}
const gateRows = async () => (await pool.query<{ platform_admin_id: string; action_type: string }>(
  `SELECT platform_admin_id, action_type FROM platform_audit_logs WHERE action_type LIKE 'TRIAL_ENTERED_%' ORDER BY created_at`)).rows;

describe('the trial gate signs with the system account', () => {
  it('even when another super_admin is the row the old query would have picked', async () => {
    // Put an ordinary admin ahead of the system account in the table, as production had fixtures.
    await pool.query(`DELETE FROM users WHERE id = $1`, [SYSTEM_ACTOR_ID]);
    await addAdmin(ROOT, ROOT_EMAIL, true);
    await addSystemActor();
    // The control: the query the gate used to run names the ordinary admin, not the system account.
    const old = await pool.query<{ id: string }>(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
    expect(old.rows[0].id).toBe(ROOT);

    const sub = await expiredTrial(1);
    const result = await runTrialExpiryCheck();
    expect(result.entered_grace).toBe(1);
    expect((await pool.query(`SELECT subscription_status FROM platform_subscriptions WHERE id = $1`, [sub])).rows[0].subscription_status).toBe('grace');

    const rows = await gateRows();
    expect(rows).toEqual([{ platform_admin_id: SYSTEM_ACTOR_ID, action_type: 'TRIAL_ENTERED_GRACE' }]);
  });
});

describe('a missing system account', () => {
  it('alarms on a run with nothing to do, and changes nothing on a run with work', async () => {
    await addAdmin(ROOT, ROOT_EMAIL, true);
    const error = jest.spyOn(logger, 'error');

    // The control: with the account present, a run with no work succeeds and raises nothing.
    await expect(runTrialExpiryCheck()).resolves.toEqual({ entered_grace: 0, entered_read_only: 0, healed: 0 });
    expect(error.mock.calls.map(c => c[0])).not.toContain('trial_expiry_system_actor_missing');

    await pool.query(`DELETE FROM users WHERE id = $1`, [SYSTEM_ACTOR_ID]);

    // Nothing due: it still says so, the first time the job fires.
    await expect(runTrialExpiryCheck()).rejects.toThrow(/system account/);
    expect(error).toHaveBeenCalledWith('trial_expiry_system_actor_missing', { pending: 0 });

    // Work due: refused whole. The trial stays where it was and nothing is signed by anyone else.
    const sub = await expiredTrial(1);
    error.mockClear();
    await expect(runTrialExpiryCheck()).rejects.toThrow(/system account/);
    expect(error).toHaveBeenCalledWith('trial_expiry_system_actor_missing', { pending: 1 });
    expect((await pool.query(`SELECT subscription_status FROM platform_subscriptions WHERE id = $1`, [sub])).rows[0].subscription_status).toBe('trial');
    expect(await gateRows()).toEqual([]);
    error.mockRestore();
  });
});

describe('the system account can never be an active admin', () => {
  it('the database refuses to activate it, and only it', async () => {
    // The control: an inactive ordinary admin can be reactivated by the same statement.
    await addAdmin(OTHER, 'other-admin@test', false);
    await pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [OTHER]);
    expect((await pool.query(`SELECT is_active FROM users WHERE id = $1`, [OTHER])).rows[0].is_active).toBe(true);

    await expect(pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [SYSTEM_ACTOR_ID]))
      .rejects.toMatchObject({ code: '23514', constraint: 'users_system_account_never_active' });
    expect((await systemRow()).is_active).toBe(false);
  });

  it('the admin list shows it, marked; all four admin actions refuse it and leave it as it was', async () => {
    await addAdmin(ROOT, ROOT_EMAIL, true);
    await addAdmin(OTHER, 'other-admin@test', true);

    const list = await request(app).get('/api/super-admin/admins').set('Authorization', auth());
    expect(list.status).toBe(200);
    const flags = Object.fromEntries((list.body.data as Array<{ id: string; is_system: boolean }>).map(a => [a.id, a.is_system]));
    expect(flags).toEqual({ [SYSTEM_ACTOR_ID]: true, [ROOT]: false, [OTHER]: false });

    // The control: the same routes, same caller, act on an ordinary admin.
    const suspended = await request(app).patch(`/api/super-admin/admins/${OTHER}/suspend`).set('Authorization', auth())
      .send({ reason: 'Control: an ordinary admin can be suspended' });
    expect(suspended.status).toBe(200);
    const resent = await request(app).post(`/api/super-admin/admins/${OTHER}/resend-welcome`).set('Authorization', auth());
    expect(resent.status).toBe(200);
    // ...and every instrument used below sees what they did, so its silence later means something.
    expect(supabaseAdmin.auth.admin.updateUserById).toHaveBeenCalled();
    expect(emailService.sendEmail).toHaveBeenCalled();
    expect((await pool.query(`SELECT count(*)::int AS n FROM platform_audit_logs WHERE target_user_id = $1`, [OTHER])).rows[0].n).toBe(2);
    jest.clearAllMocks();
    const before = await systemRow();
    expect(before).toEqual({ email: SYSTEM_ACTOR.email, first_name: 'Chronix', last_name: 'System', is_active: false, role: 'super_admin' });

    const calls = [
      request(app).post(`/api/super-admin/admins/${SYSTEM_ACTOR_ID}/resend-welcome`).set('Authorization', auth()),
      request(app).patch(`/api/super-admin/admins/${SYSTEM_ACTOR_ID}/suspend`).set('Authorization', auth()).send({ reason: 'Trying to suspend the system account' }),
      request(app).patch(`/api/super-admin/admins/${SYSTEM_ACTOR_ID}/reactivate`).set('Authorization', auth()).send({ reason: 'Trying to reactivate the system account' }),
      request(app).delete(`/api/super-admin/admins/${SYSTEM_ACTOR_ID}`).set('Authorization', auth()).send({ confirmation_email: SYSTEM_ACTOR.email }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SYSTEM_ACCOUNT');
    }

    expect(await systemRow()).toEqual(before);
    expect((await pool.query(`SELECT count(*)::int AS n FROM platform_audit_logs WHERE target_user_id = $1`, [SYSTEM_ACTOR_ID])).rows[0].n).toBe(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
