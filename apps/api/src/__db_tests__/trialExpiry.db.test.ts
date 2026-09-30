/**
 * Trial status and the trial-expiry job — the four defects behind Chronix High School's
 * suspension (8 Sep 2026) and the ₦50,000 recorded against its suspended row (28 Sep).
 *
 *   1. PATCH /subscriptions/:id with only `plan` left subscription_status at 'trial'.
 *   2. runTrialExpiryCheck() selected on status alone and suspended a paid plan.
 *   3. record-payment succeeded against a suspended subscription and reconciled nothing.
 *   4. (UI only) nothing could un-suspend — covered here by the route accepting 'active'.
 *   Plus the timing: trial_ends_at is stored at midnight and the job runs at 09:00, so a
 *   trial "ending 8 Sep" died on the morning of the 8th. The end date is now inclusive.
 *
 * Doctrine 16 throughout: every "survives" and "unchanged" is preceded by the state it must
 * keep, and every "not gated" sits beside a control that IS moved into grace by the same run.
 * Since migration 046 the job moves an expired trial into grace, never suspends it, and
 * never touches schools.is_active (trialGate.db.test.ts covers the whole gate).
 */
import request from 'supertest';
import express from 'express';
import { seed, IDS as I, pool, token } from './helpers';
import superAdminRouter from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { runTrialExpiryCheck } from '../services/subscriptionService';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);

const SA = 'a5a00000-0000-4000-8000-000000000002';
const sa = () => token(SA, 'super_admin', I.schoolA);

beforeEach(async () => {
  await seed();
  // The route's audit row and the job's system-admin lookup both need a super_admin.
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, NULL, 'sa2@test', 'x', 'super_admin', 'Super', 'Admin', true, 'subject', false)`,
    [SA]
  );
  await pool.query(`INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (80000) ON CONFLICT (id) DO NOTHING`);
});
afterAll(async () => { await pool.end(); });

const create = (body: object) => request(app).post('/api/super-admin/subscriptions').set('Authorization', sa()).send(body);
const patch = (id: string, body: object) => request(app).patch(`/api/super-admin/subscriptions/${id}`).set('Authorization', sa()).send(body);
const pay = (id: string) => request(app).post(`/api/super-admin/subscriptions/${id}/record-payment`).set('Authorization', sa())
  .send({ amount: 50000, reference: 'REF-1', payment_date: '2026-09-28' });

async function state(subId: string) {
  const { rows } = await pool.query<{ plan: string; subscription_status: string; is_active: boolean }>(
    `SELECT p.plan, p.subscription_status, s.is_active FROM platform_subscriptions p JOIN schools s ON s.id = p.school_id WHERE p.id = $1`, [subId]);
  return rows[0];
}
/** trial_ends_at = midnight in Africa/Lagos, `daysAgo` days before today's Lagos date. */
async function setEndsDaysAgo(subId: string, daysAgo: number) {
  await pool.query(
    `UPDATE platform_subscriptions
        SET trial_ends_at = ((date_trunc('day', NOW() AT TIME ZONE 'Africa/Lagos') - make_interval(days => $2)) AT TIME ZONE 'Africa/Lagos')
      WHERE id = $1`, [subId, daysAgo]);
}
async function trialFor(schoolId: string, daysAgo: number): Promise<string> {
  const res = await create({ school_id: schoolId, plan: 'trial' });
  expect(res.status).toBe(201);
  await setEndsDaysAgo(res.body.data.id, daysAgo);
  return res.body.data.id;
}
const audits = async (type: string) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM platform_audit_logs WHERE action_type = $1`, [type])).rows[0].n;

describe('leaving trial for a paid plan', () => {
  it('a plan change alone clears the trial status at the route — every caller is safe, not only the UI', async () => {
    const id = await trialFor(I.schoolA, 1);
    expect((await state(id)).subscription_status).toBe('trial');
    const res = await patch(id, { plan: 'premium' });
    expect(res.status).toBe(200);
    expect(res.body.data.subscription_status).toBe('active');
    expect((await state(id))).toMatchObject({ plan: 'premium', subscription_status: 'active' });
  });

  it('asking outright for trial status on a paid plan is refused, not written', async () => {
    const id = await trialFor(I.schoolA, 1);
    const res = await patch(id, { plan: 'premium', subscription_status: 'trial' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INCONSISTENT_STATUS');
    expect((await state(id))).toMatchObject({ plan: 'trial', subscription_status: 'trial' }); // untouched
  });

  it('a subscription upgraded from an already-expired trial survives the expiry run', async () => {
    const id = await trialFor(I.schoolA, 1);
    await patch(id, { plan: 'premium' });
    expect((await state(id))).toMatchObject({ subscription_status: 'active', is_active: true }); // before the run
    const control = await trialFor(I.schoolB, 1); // a genuine expired trial, in the same run
    const r = await runTrialExpiryCheck();
    expect(r.entered_grace).toBe(1);
    expect((await state(id))).toMatchObject({ plan: 'premium', subscription_status: 'active', is_active: true });
    expect((await state(control))).toMatchObject({ subscription_status: 'grace', is_active: true });
  });
});

describe('the expiry run and a paid plan already in trial status', () => {
  it('does not suspend it; corrects it to active, audits, and leaves the school alone', async () => {
    const id = await trialFor(I.schoolA, 1);
    // Written directly — the state the route now refuses, as production held it for five days.
    await pool.query(`UPDATE platform_subscriptions SET plan = 'premium' WHERE id = $1`, [id]);
    expect((await state(id))).toMatchObject({ plan: 'premium', subscription_status: 'trial', is_active: true });
    const before = await audits('TRIAL_ENTERED_GRACE');
    const r = await runTrialExpiryCheck();
    expect(r).toMatchObject({ entered_grace: 0, healed: 1 });
    expect((await state(id))).toMatchObject({ plan: 'premium', subscription_status: 'active', is_active: true });
    expect(await audits('TRIAL_STATUS_CLEARED_PAID_PLAN')).toBe(1);
    expect(await audits('TRIAL_ENTERED_GRACE')).toBe(before);
  });
});

describe('the end date is inclusive, in Africa/Lagos', () => {
  it('a trial ending today is still usable; one that ended yesterday enters grace in the same run', async () => {
    const today = await trialFor(I.schoolA, 0);
    const yesterday = await trialFor(I.schoolB, 1);
    const r = await runTrialExpiryCheck();
    expect(r.entered_grace).toBe(1);
    expect((await state(today))).toMatchObject({ subscription_status: 'trial', is_active: true });
    expect((await state(yesterday))).toMatchObject({ subscription_status: 'grace', is_active: true });
  });
});

describe('recording a payment', () => {
  it('against a suspended subscription reactivates the subscription — not the school — and says so', async () => {
    const id = await trialFor(I.schoolA, 1);
    await patch(id, { plan: 'premium' });
    await patch(id, { subscription_status: 'suspended' });
    await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [I.schoolA]); // as the job would have left it
    expect((await state(id))).toMatchObject({ subscription_status: 'suspended', is_active: false });
    const res = await pay(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subscription_status_before: 'suspended', subscription_status: 'active', subscription_reactivated: true });
    expect((await state(id))).toMatchObject({ subscription_status: 'active', is_active: false });
    const { rows } = await pool.query<{ metadata: { subscription_reactivated: boolean } }>(
      `SELECT metadata FROM platform_audit_logs WHERE action_type = 'MANUAL_PAYMENT_RECORDED' ORDER BY created_at DESC LIMIT 1`);
    expect(rows[0].metadata.subscription_reactivated).toBe(true);
  });

  it('against an active subscription changes nothing and says so', async () => {
    const id = await trialFor(I.schoolA, 1);
    await patch(id, { plan: 'premium' });
    const res = await pay(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subscription_status_before: 'active', subscription_status: 'active', subscription_reactivated: false });
  });

  it('against a cancelled subscription is refused and records nothing', async () => {
    const id = await trialFor(I.schoolA, 1);
    await patch(id, { plan: 'premium' });
    await patch(id, { subscription_status: 'cancelled' });
    const before = await audits('MANUAL_PAYMENT_RECORDED');
    const res = await pay(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_CANCELLED');
    expect(await audits('MANUAL_PAYMENT_RECORDED')).toBe(before);
  });
});

describe('the route can un-suspend', () => {
  it('subscription_status: active is accepted after a suspension', async () => {
    const id = await trialFor(I.schoolA, 1);
    await patch(id, { plan: 'premium' });
    await patch(id, { subscription_status: 'suspended' });
    expect((await state(id)).subscription_status).toBe('suspended');
    const res = await patch(id, { subscription_status: 'active' });
    expect(res.status).toBe(200);
    expect((await state(id)).subscription_status).toBe('active');
  });
});
