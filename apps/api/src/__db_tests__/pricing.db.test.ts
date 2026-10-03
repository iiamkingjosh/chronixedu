/**
 * The per-student rate (3 Oct 2026). Every paid subscription is priced from it, and until now nothing
 * in the product could set it: it was typed into the database by hand, with no record of who set
 * Chronix's price, when, or what it was before. And changing it repriced nothing: amount_naira is
 * derived only when a subscription row is written, so each kept the old price until touched.
 *
 * Now the root admin sets it with PUT /super-admin/pricing: under one lock, with the prior value read
 * there, every paid subscription repriced in the same transaction, and the change audited. Each
 * refusal follows the same thing succeeding (doctrine 16).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { seed, IDS as I, pool } from './helpers';
import superAdminRouter from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);

const ROOT = 'c0000000-0000-4000-8000-0000000000d1';
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL!;
const OTHER = 'c0000000-0000-4000-8000-0000000000d2';
const OTHER_EMAIL = 'other-admin@pricing.test';
const as = (id: string, email: string) => 'Bearer ' + jwt.sign({ user_id: id, school_id: null, role: 'super_admin', email }, process.env.JWT_SECRET!);
const root = () => as(ROOT, ROOT_EMAIL);
const other = () => as(OTHER, OTHER_EMAIL);

beforeEach(async () => {
  await seed();
  for (const [id, email] of [[ROOT, ROOT_EMAIL], [OTHER, OTHER_EMAIL]]) {
    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ($1, NULL, $2, 'x', 'super_admin', 'Some', 'Admin', true, 'subject', false)`, [id, email]);
  }
});
afterAll(async () => { await pool.end(); });

const getRate = () => request(app).get('/api/super-admin/pricing').set('Authorization', root());
const setRate = (kobo: unknown, auth = root()) => request(app).put('/api/super-admin/pricing').set('Authorization', auth).send({ price_per_student_kobo: kobo });
const storedRate = async () => (await pool.query(`SELECT price_per_student_kobo FROM platform_pricing_config`)).rows[0]?.price_per_student_kobo ?? null;
const audits = async () => (await pool.query<{ platform_admin_id: string; metadata: Record<string, unknown> }>(
  `SELECT platform_admin_id, metadata FROM platform_audit_logs WHERE action_type = 'PRICING_RATE_SET' ORDER BY created_at`)).rows;
const amount = async (school: string) => (await pool.query<{ amount_naira: string }>(
  `SELECT amount_naira FROM platform_subscriptions WHERE school_id = $1`, [school])).rows[0].amount_naira;
const subscribe = (school: string, plan: string) =>
  request(app).post('/api/super-admin/subscriptions').set('Authorization', root()).send({ school_id: school, plan });

describe('the per-student rate', () => {
  it('starts unset, and while it is, a paid subscription is refused', async () => {
    const res = await getRate();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ price_per_student_kobo: null, last_set: null, can_edit: true });
    const asOther = await request(app).get('/api/super-admin/pricing').set('Authorization', other());
    expect(asOther.body.data.can_edit).toBe(false);

    const refused = await subscribe(I.schoolA, 'premium');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('BILLING_RATE_NOT_CONFIGURED');
    expect(refused.body.error.message).toMatch(/Subscriptions → Per-student rate/);
  });

  it('only the root admin may set it', async () => {
    const denied = await setRate(80000, other());
    expect(denied.status).toBe(403);
    expect(await storedRate()).toBeNull();

    const ok = await setRate(80000);
    expect(ok.status).toBe(200);
    expect(Number(await storedRate())).toBe(80000);
  });

  it('records each change with the value it replaced: the second save names the first', async () => {
    const first = await setRate(80000);
    expect(first.body.data).toMatchObject({ price_per_student_kobo: 80000, previous_kobo: null });
    const second = await setRate(100000);
    expect(second.body.data).toMatchObject({ price_per_student_kobo: 100000, previous_kobo: 80000 });

    expect(await audits()).toEqual([
      { platform_admin_id: ROOT, metadata: { previous_kobo: null, new_kobo: 80000, subscriptions_repriced: 0 } },
      { platform_admin_id: ROOT, metadata: { previous_kobo: 80000, new_kobo: 100000, subscriptions_repriced: 0 } },
    ]);
    const shown = await getRate();
    expect(shown.body.data).toMatchObject({ price_per_student_kobo: 100000, last_set: { by: 'Some Admin' } });
  });

  it('reprices every paid subscription at once, and leaves a trial at ₦0', async () => {
    const billable = (await pool.query<{ n: number }>(`SELECT billable_student_count($1) AS n`, [I.schoolA])).rows[0].n;
    expect(billable).toBeGreaterThan(0);

    await setRate(80000);
    expect((await subscribe(I.schoolA, 'premium')).status).toBe(201);
    expect((await subscribe(I.schoolB, 'trial')).status).toBe(201);
    expect(Number(await amount(I.schoolA))).toBe(billable * 800);
    expect(Number(await amount(I.schoolB))).toBe(0);

    const res = await setRate(100000);
    expect(res.body.data.subscriptions_repriced).toBe(1);
    expect(Number(await amount(I.schoolA))).toBe(billable * 1000);
    expect(Number(await amount(I.schoolB))).toBe(0);
    expect((await audits())[1].metadata).toMatchObject({ previous_kobo: 80000, new_kobo: 100000, subscriptions_repriced: 1 });
  });

  it('previews the bill a rate would produce, writing nothing, and the save then charges exactly that', async () => {
    const billable = (await pool.query<{ n: number }>(`SELECT billable_student_count($1) AS n`, [I.schoolA])).rows[0].n;
    expect(billable).toBeGreaterThan(0);
    await setRate(80000);
    expect((await subscribe(I.schoolA, 'premium')).status).toBe(201);
    expect((await subscribe(I.schoolB, 'trial')).status).toBe(201);

    const preview = await request(app).get('/api/super-admin/pricing/preview?price_per_student_kobo=100000').set('Authorization', root());
    expect(preview.status).toBe(200);
    // The paid school only, with the arithmetic the confirm step reads out.
    expect(preview.body.data.subscriptions).toEqual([{
      school_name: 'School A', is_demo: false, plan: 'premium', billable_students: billable,
      current_amount_kobo: billable * 80000, new_amount_kobo: billable * 100000, kept_reason: null,
    }]);
    // Nothing written.
    expect(Number(await storedRate())).toBe(80000);
    expect(await audits()).toHaveLength(1);
    expect(Number(await amount(I.schoolA))).toBe(billable * 800);

    await setRate(100000);
    expect(Math.round(Number(await amount(I.schoolA)) * 100)).toBe(preview.body.data.subscriptions[0].new_amount_kobo);

    const bad = await request(app).get('/api/super-admin/pricing/preview?price_per_student_kobo=80.5').set('Authorization', root());
    expect(bad.status).toBe(400);
  });

  it('refuses a rate that is not a whole number of kobo in range, and changes nothing', async () => {
    expect((await setRate(80000)).status).toBe(200);
    for (const bad of [0, -800, 800.5, '80000', null, 10_000_001]) {
      const res = await setRate(bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
    expect(Number(await storedRate())).toBe(80000);
    expect(await audits()).toHaveLength(1);
  });
});
