/**
 * Onboarding: the calendar step can be saved again, and completing it starts a trial
 * (audit, 8 Oct 2026; Moses: onboarding starts a trial, "Yes").
 *
 * - Step 3 inserted a new CURRENT session and term every time it was saved. Going back to fix a
 *   date and saving again hit the one-current-session index and answered 500, so a typo in a
 *   term date could not be corrected inside the wizard.
 * - /complete activated the school with no subscription at all, so a new school had no trial
 *   clock, no plan, and nothing for the trial gate to act on, until someone remembered to
 *   create one on the Subscriptions page.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { seed, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';

jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    createUser: jest.fn(async () => ({ data: { user: { id: 'd1d1d1d1-0000-4000-8000-000000000002' } }, error: null })),
    generateLink: jest.fn(async () => ({ data: { properties: { action_link: 'https://auth.example.test/verify?type=recovery&token=t' } }, error: null })),
  } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => false),
}));

const wizard = express();
wizard.use(express.json());
wizard.use('/api/super-admin', superAdminRoutes);
wizard.use(errorHandler);

const SUPER = 'c0000000-0000-4000-8000-000000000004';
const auth = () => 'Bearer ' + jwt.sign({ user_id: SUPER, school_id: null, role: 'super_admin', email: 'wizard2@test' }, process.env.JWT_SECRET!);
const step = (sid: string, n: number, body: object) =>
  request(wizard).patch(`/api/super-admin/onboarding/${sid}/step/${n}`).set('Authorization', auth()).send(body);

async function startWizard(): Promise<{ sid: string; schoolId: string }> {
  const start = await request(wizard).post('/api/super-admin/onboarding').set('Authorization', auth())
    .send({ school_name: 'Calendar School', school_email: 'office@calendar.test', is_demo: true });
  expect(start.status).toBe(201);
  return { sid: start.body.data.session_id, schoolId: start.body.data.school_id };
}

async function calendar(schoolId: string) {
  return (await pool.query(
    `SELECT s.name AS session_name, s.start_date::text AS session_start, s.end_date::text AS session_end, s.is_current AS session_current,
            t.name AS term_name, t.start_date::text AS term_start, t.end_date::text AS term_end, t.is_current AS term_current
       FROM academic_sessions s JOIN terms t ON t.session_id = s.id WHERE s.school_id = $1`, [schoolId])).rows;
}

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, two_factor_required)
     VALUES ($1, NULL, 'wizard2@test', 'x', 'super_admin', 'Wiz', 'Two', false)`, [SUPER]);
});
afterAll(() => pool.end());

describe('the calendar step', () => {
  it('saved twice keeps one session and one term, with the second save’s values', async () => {
    const { sid, schoolId } = await startWizard();
    const first = await step(sid, 3, { session_name: '2026/2027', term: { name: 'First Term', start_date: '2026-09-14', end_date: '2026-12-18' } });
    expect(first.status).toBe(200);
    expect(await calendar(schoolId)).toHaveLength(1);

    const fixed = await step(sid, 3, { session_name: '2026-2027', term: { name: '1st Term', start_date: '2026-09-07', end_date: '2026-12-11' } });
    expect(fixed.status).toBe(200);
    expect(await calendar(schoolId)).toEqual([{
      session_name: '2026-2027', session_start: '2026-09-07', session_end: '2026-12-11', session_current: true,
      term_name: '1st Term', term_start: '2026-09-07', term_end: '2026-12-11', term_current: true,
    }]);
  });
});

describe('completing onboarding', () => {
  async function completeWizard() {
    const { sid, schoolId } = await startWizard();
    expect((await step(sid, 1, { name: 'Calendar School', address: '2 Road', phone: '08000000001' })).status).toBe(200);
    expect((await step(sid, 2, { motto: '' })).status).toBe(200);
    expect((await step(sid, 3, { session_name: '2026/2027', term: { name: 'First Term', start_date: '2026-09-14', end_date: '2026-12-18' } })).status).toBe(200);
    expect((await step(sid, 4, { first_name: 'Bola', last_name: 'Ade', email: 'principal@calendar.test', email_confirmation: 'principal@calendar.test' })).status).toBe(200);
    return { sid, schoolId };
  }
  const complete = (sid: string) => request(wizard).post(`/api/super-admin/onboarding/${sid}/complete`)
    .set('Authorization', auth()).send({ accepted_legal_terms: true, principal_email_read_back: true });

  it('starts a 30-day trial, records it, and says so', async () => {
    const { sid, schoolId } = await completeWizard();
    const before = Date.now();
    const done = await complete(sid);
    expect(done.status).toBe(200);
    expect(done.body.data.trial_ends_at).toEqual(expect.any(String));

    const sub = (await pool.query(
      `SELECT plan, subscription_status, billing_cycle, trial_ends_at FROM platform_subscriptions WHERE school_id = $1`, [schoolId])).rows;
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({ plan: 'trial', subscription_status: 'trial', billing_cycle: 'termly' });
    const days = (new Date(sub[0].trial_ends_at).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect((await pool.query(`SELECT subscription_tier FROM schools WHERE id = $1`, [schoolId])).rows[0].subscription_tier).toBe('trial');

    const audit = (await pool.query(
      `SELECT platform_admin_id, metadata FROM platform_audit_logs WHERE action_type = 'SUBSCRIPTION_CREATED' AND target_school_id = $1`, [schoolId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].platform_admin_id).toBe(SUPER);
    expect(audit[0].metadata).toMatchObject({ plan: 'trial', reason: 'onboarding_completed' });
  });

  it('leaves a subscription made during onboarding as it is', async () => {
    const { sid, schoolId } = await completeWizard();
    await pool.query(
      `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, trial_ends_at, subscription_status)
       VALUES ($1, 'trial', 'termly', NOW() + interval '60 days', 'trial')`, [schoolId]);
    const done = await complete(sid);
    expect(done.status).toBe(200);
    const sub = (await pool.query(`SELECT trial_ends_at FROM platform_subscriptions WHERE school_id = $1`, [schoolId])).rows;
    expect(sub).toHaveLength(1);
    expect((new Date(sub[0].trial_ends_at).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(59);
    expect((await pool.query(`SELECT 1 FROM platform_audit_logs WHERE action_type = 'SUBSCRIPTION_CREATED' AND target_school_id = $1`, [schoolId])).rowCount).toBe(0);
  });
});

describe('the address', () => {
  it('typed at onboarding is the address receipts and report cards print', async () => {
    const { sid, schoolId } = await startWizard();
    expect((await step(sid, 1, { name: 'Calendar School', address: '2 Road, Ibadan', phone: '08000000001' })).status).toBe(200);
    const row = (await pool.query(`SELECT identity_config->>'address' AS address FROM school_settings WHERE school_id = $1`, [schoolId])).rows[0];
    expect(row.address).toBe('2 Road, Ibadan');
  });
});
