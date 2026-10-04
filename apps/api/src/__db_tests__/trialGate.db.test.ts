/**
 * Termly billing, MRR, derived billing dates, and the trial gate (migration 046).
 *
 * Doctrine 16 throughout: a refused write sits beside a read that still works; "is_active
 * untouched" is asserted as TRUE after transitions that used to set it false; every
 * "not yet known" sits beside a known date from the same function.
 */
import request from 'supertest';
import express from 'express';
import { buildApp, seed, IDS as I, pool, token, tokens } from './helpers';
import superAdminRouter from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { runTrialExpiryCheck } from '../services/subscriptionService';
import { getPlatformRevenue } from '../db/queries/platformRevenue';
import { READ_ONLY_WRITE_ALLOWLIST } from '../middleware/requireWritableSubscription';
import { cache, schoolCacheKey } from '../services/cacheService';

const app = buildApp();
const admin = express();
admin.use(express.json());
admin.use('/api/super-admin', superAdminRouter);
admin.use(errorHandler);

const SA = 'a5a00000-0000-4000-8000-000000000003';
const sa = () => token(SA, 'super_admin', I.schoolA);
const base = `/api/schools/${I.schoolA}`;

beforeEach(async () => {
  await seed();
  cache.del(schoolCacheKey(I.schoolA, 'data'));
  cache.del(schoolCacheKey(I.schoolB, 'data'));
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'sa3@test', 'x', 'super_admin', 'Super', 'Admin', true, 'subject', false, false)`, [SA]);
  await pool.query(`INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (80000) ON CONFLICT (id) DO NOTHING`);
});
afterAll(async () => { await pool.end(); });

const create = (body: object) => request(admin).post('/api/super-admin/subscriptions').set('Authorization', sa()).send(body);

/** A trial whose last day was `daysAgo` days before today in Africa/Lagos (0 = today). */
async function trialEndedDaysAgo(schoolId: string, daysAgo: number): Promise<string> {
  const res = await create({ school_id: schoolId, plan: 'trial' });
  expect(res.status).toBe(201);
  await pool.query(
    `UPDATE platform_subscriptions
        SET trial_ends_at = ((date_trunc('day', NOW() AT TIME ZONE 'Africa/Lagos') - make_interval(days => $2)) AT TIME ZONE 'Africa/Lagos')
      WHERE id = $1`, [res.body.data.id, daysAgo]);
  return res.body.data.id;
}
const status = async (subId: string) =>
  (await pool.query<{ subscription_status: string; plan: string }>(`SELECT subscription_status, plan FROM platform_subscriptions WHERE id = $1`, [subId])).rows[0];
const isActive = async (schoolId: string) =>
  (await pool.query<{ is_active: boolean }>(`SELECT is_active FROM schools WHERE id = $1`, [schoolId])).rows[0].is_active;
const audits = async (type: string) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM platform_audit_logs WHERE action_type = $1`, [type])).rows[0].n;
const postNotice = (auth: string) =>
  request(app).post(`${base}/notices`).set('Authorization', auth).send({ class_id: I.jss2a, title: 'Sports day', body: 'Friday, 10am.' });
const getNotices = (auth: string) => request(app).get(`${base}/notices`).set('Authorization', auth);

describe('termly billing', () => {
  it('a new subscription is termly unless told otherwise', async () => {
    const res = await create({ school_id: I.schoolA, plan: 'premium' });
    expect(res.status).toBe(201);
    expect(res.body.data.billing_cycle).toBe('termly');
  });

  it('a termly subscription of ₦1,600 contributes ₦400 to MRR — not ₦1,600', async () => {
    // Two enrolled pupils would be ₦1,600; the seed enrols three, so pin the roll at two.
    await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s3OtherClass]);
    const res = await create({ school_id: I.schoolA, plan: 'premium', billing_cycle: 'termly' });
    expect(res.body.data.amount_naira).toBe('1600.00');
    const revenue = await getPlatformRevenue();
    expect(revenue.total_mrr_kobo).toBe(40_000);
    expect(revenue.by_plan).toEqual([
      { plan: 'premium', mrr_kobo: 40_000, count: 1 },
      { plan: 'enterprise', mrr_kobo: 0, count: 0 },
    ]);
  });

  it('the subscriptions summary reads the same MRR, not a sum of its own', async () => {
    await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s3OtherClass]);
    await create({ school_id: I.schoolA, plan: 'premium', billing_cycle: 'termly' });
    const res = await request(admin).get('/api/super-admin/subscriptions').set('Authorization', sa());
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total_mrr_naira).toBe(400);
  });

  it("'basic' is no longer a plan — refused, and refused for the plan", async () => {
    // A complete body, so the only thing wrong with it is the plan. (The first version of
    // this test omitted billing_cycle, which the old code required — so it passed on the
    // old code for the wrong reason.)
    const res = await create({ school_id: I.schoolA, plan: 'basic', billing_cycle: 'monthly' });
    expect(res.status).toBe(400);
    expect(res.body.error.message.fieldErrors.plan).toBeTruthy();
  });
});

describe('the next billing date follows the school’s own term calendar', () => {
  const detail = async () => (await request(admin).get(`/api/super-admin/schools/${I.schoolA}`).set('Authorization', sa())).body.data.subscription;

  it('is the next term’s start date when one is set — and "not yet known", not blank, when none is', async () => {
    await create({ school_id: I.schoolA, plan: 'premium' });
    let sub = await detail();
    expect(sub).toMatchObject({ next_billing_date: null, next_billing_basis: 'not_yet_known' });

    await pool.query(
      `INSERT INTO terms (session_id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, 'Second Term', ((NOW() AT TIME ZONE 'Africa/Lagos')::date + 40), ((NOW() AT TIME ZONE 'Africa/Lagos')::date + 120), false)`,
      [I.sessionA, I.schoolA]);
    const { rows } = await pool.query<{ d: string }>(`SELECT ((NOW() AT TIME ZONE 'Africa/Lagos')::date + 40)::text AS d`);
    sub = await detail();
    expect(sub.next_billing_basis).toBe('next_term');
    expect(String(sub.next_billing_date).slice(0, 10)).toBe(rows[0].d);
  });

  it('a trial is "not billed"', async () => {
    await create({ school_id: I.schoolA, plan: 'trial' });
    expect((await detail()).next_billing_basis).toBe('not_billed');
  });
});

describe('the trial gate: trial, 14 days of grace, then read-only', () => {
  it('day 31 is grace: audited, full access, the school still active', async () => {
    const id = await trialEndedDaysAgo(I.schoolA, 1);
    expect((await status(id)).subscription_status).toBe('trial');
    const r = await runTrialExpiryCheck();
    expect(r).toMatchObject({ entered_grace: 1, entered_read_only: 0 });
    expect((await status(id)).subscription_status).toBe('grace');
    expect(await isActive(I.schoolA)).toBe(true);
    expect(await audits('TRIAL_ENTERED_GRACE')).toBe(1);
    expect((await postNotice(tokens.principalA())).status).toBe(201);
  });

  it('day 44 is still grace; day 45 is read-only', async () => {
    const last = await trialEndedDaysAgo(I.schoolA, 14);
    const over = await trialEndedDaysAgo(I.schoolB, 15);
    await runTrialExpiryCheck();
    expect((await status(last)).subscription_status).toBe('grace');
    expect((await status(over)).subscription_status).toBe('read_only');
    // A missed run catches up, and both stages are on record.
    expect(await audits('TRIAL_ENTERED_GRACE')).toBe(2);
    expect(await audits('TRIAL_ENTERED_READ_ONLY')).toBe(1);
  });

  it('read-only: the GET still works and the POST is refused — both asserted', async () => {
    await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    expect((await getNotices(tokens.principalA())).status).toBe(200);
    const write = await postNotice(tokens.principalA());
    expect(write.status).toBe(423);
    expect(write.body.error.code).toBe('SCHOOL_READ_ONLY');
  });

  it('read-only takes the plan’s extras away: analytics answers FEATURE_NOT_IN_PLAN', async () => {
    await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    const { planIncludesFeature } = await import('../services/planFeatures');
    const { rows } = await pool.query(`SELECT s.subscription_tier, ps.subscription_status FROM schools s JOIN platform_subscriptions ps ON ps.school_id = s.id WHERE s.id = $1`, [I.schoolA]);
    expect(planIncludesFeature(rows[0].subscription_tier, 'analytics', rows[0].subscription_status)).toBe(false);
  });

  it('is_active is untouched by every transition — the school is active before and after each', async () => {
    const id = await trialEndedDaysAgo(I.schoolA, 1);
    expect(await isActive(I.schoolA)).toBe(true);
    await runTrialExpiryCheck();
    expect((await status(id)).subscription_status).toBe('grace');
    expect(await isActive(I.schoolA)).toBe(true);
    await pool.query(`UPDATE platform_subscriptions SET trial_ends_at = trial_ends_at - INTERVAL '20 days' WHERE id = $1`, [id]);
    await runTrialExpiryCheck();
    expect((await status(id)).subscription_status).toBe('read_only');
    expect(await isActive(I.schoolA)).toBe(true);
  });

  it('a super_admin can still write to a read-only school', async () => {
    await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    expect((await postNotice(tokens.principalA())).status).toBe(423);
    expect((await postNotice(sa())).status).toBe(201);
  });

  it('the payment carve-out lets a listed route write while read-only, and nothing else', async () => {
    // The mechanism, end to end through the real guard. That a platform payment route cannot
    // EXIST without being carved out is carveOut.test.ts — this file used to assert the list
    // was empty, which is true until someone edits it and proves nothing.
    await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    expect((await postNotice(tokens.principalA())).status).toBe(423);
    // Snapshot and restore rather than resetting to [] — the allowlist carries a real
    // production entry since routes/platformBilling.ts shipped its checkout route.
    const before = [...READ_ONLY_WRITE_ALLOWLIST];
    READ_ONLY_WRITE_ALLOWLIST.push({ method: 'POST', path: /^\/[0-9a-f-]{36}\/notices$/, why: 'test stand-in for a payment route' });
    try {
      expect((await postNotice(tokens.principalA())).status).toBe(201);
    } finally {
      READ_ONLY_WRITE_ALLOWLIST.length = 0;
      READ_ONLY_WRITE_ALLOWLIST.push(...before);
    }
  });

  it('the real platform-billing checkout route is itself carved out, end to end', async () => {
    // The actual route, not a stand-in — routes/platformBilling.ts's checkout, carved out
    // via its own READ_ONLY_WRITE_ALLOWLIST entry rather than a test-pushed one.
    await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    const res = await request(app)
      .post(`${base}/platform-billing/checkout`)
      .set('Authorization', tokens.principalA());
    // trialEndedDaysAgo leaves the subscription on plan 'trial' (the trial-expiry job only
    // ever changes subscription_status, never plan — CLAUDE.md, Platform billing), so the
    // route's own TRIAL_NOT_BILLABLE refusal fires. The point of this test is only that it
    // is REACHED past the read-only guard (409, business-rule refusal) rather than stopped
    // by it (423 SCHOOL_READ_ONLY).
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRIAL_NOT_BILLABLE');
  });

  it('recording a payment against a read-only trial restores it: active, and on premium', async () => {
    const id = await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    expect((await status(id)).subscription_status).toBe('read_only');
    const res = await request(admin).post(`/api/super-admin/subscriptions/${id}/record-payment`).set('Authorization', sa())
      .send({ amount: 2400, reference: 'REF-RO', payment_date: '2026-10-01' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subscription_status_before: 'read_only', subscription_status: 'active', plan: 'premium', upgraded_from_trial: true });
    expect(await status(id)).toEqual({ subscription_status: 'active', plan: 'premium' });
    expect((await postNotice(tokens.principalA())).status).toBe(201);
    expect(await isActive(I.schoolA)).toBe(true);
  });

  it('extending a read-only trial is a way back: the status follows the new end date', async () => {
    const id = await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    const res = await request(admin).post(`/api/super-admin/subscriptions/${id}/extend-trial`).set('Authorization', sa()).send({ days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.data.subscription_status).toBe('trial');
    expect((await postNotice(tokens.principalA())).status).toBe(201);
  });
});

describe('what a read-only school still sends', () => {
  it('no fee reminders — the function returns 0 without looking at balances', async () => {
    const { sendFeeRemindersForSchool } = await import('../services/feeReminderService');
    await trialEndedDaysAgo(I.schoolA, 15);
    await runTrialExpiryCheck();
    expect(await sendFeeRemindersForSchool(I.schoolA, I.termA)).toBe(0);
  });

  it('no SMS: the notification worker’s check answers false for read-only, true before it', async () => {
    const { schoolAllowsFeature } = await import('../services/planFeatures');
    await trialEndedDaysAgo(I.schoolA, 1);
    await runTrialExpiryCheck();
    expect(await schoolAllowsFeature(I.schoolA, 'sms')).toBe(true); // grace: still has it
    await pool.query(`UPDATE platform_subscriptions SET subscription_status = 'read_only' WHERE school_id = $1`, [I.schoolA]);
    expect(await schoolAllowsFeature(I.schoolA, 'sms')).toBe(false);
  });
});

describe('the in-app notice', () => {
  const state = async (auth: string) => (await request(app).get(`${base}/subscription-status`).set('Authorization', auth)).body.data;

  it('grace names the days left, read-only says so, and a teacher can read it too', async () => {
    await trialEndedDaysAgo(I.schoolA, 1);
    await runTrialExpiryCheck();
    expect(await state(tokens.math())).toMatchObject({ state: 'grace', days_left: 14 });
    await pool.query(`UPDATE platform_subscriptions SET subscription_status = 'read_only' WHERE school_id = $1`, [I.schoolA]);
    expect(await state(tokens.principalA())).toMatchObject({ state: 'read_only', days_left: null });
  });

  it("another school's staff cannot read it", async () => {
    await trialEndedDaysAgo(I.schoolA, 1);
    const res = await request(app).get(`${base}/subscription-status`).set('Authorization', tokens.principalB());
    expect(res.status).toBe(403);
  });
});
