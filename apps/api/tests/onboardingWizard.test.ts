import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import superAdminRouter from '../src/routes/superAdmin';
import { errorHandler } from '../src/middleware/errorHandler';
import { supabaseAdmin } from '../src/supabaseClient';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Onboarding Wizard', () => {
  let superAdminUserId: string;
  let superAdminToken: string;
  let sessionId: string;
  let onboardingSchoolId: string;
  let principalUserId: string | null = null;

  const onboardingSchoolEmail = `onboarding-wizard-${randomUUID()}@test.com`;
  const principalEmail = `onboarding-principal-${randomUUID()}@test.com`;

  beforeAll(async () => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES (NULL, $1, 'test-hash', 'super_admin', 'Onboarding', 'Admin', 'subject')
       RETURNING id`,
      [`onboarding-admin-${randomUUID()}@test.com`]
    );
    superAdminUserId = result.rows[0].id;
    const row = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [superAdminUserId]);
    superAdminToken = makeToken(superAdminUserId, 'super_admin', null, row.rows[0].email);
  }, 20000);

  afterAll(async () => {
    if (principalUserId) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [principalUserId]).catch(() => {});
      await supabaseAdmin.auth.admin.deleteUser(principalUserId).catch(() => {});
    }
    if (onboardingSchoolId) {
      await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [onboardingSchoolId]).catch(() => {});
      await pool.query(`DELETE FROM onboarding_sessions WHERE school_id = $1`, [onboardingSchoolId]).catch(() => {});
      await pool.query(`DELETE FROM terms WHERE school_id = $1`, [onboardingSchoolId]).catch(() => {});
      await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [onboardingSchoolId]).catch(() => {});
      await pool.query(`DELETE FROM school_settings WHERE school_id = $1`, [onboardingSchoolId]).catch(() => {});
      await pool.query(`DELETE FROM schools WHERE id = $1`, [onboardingSchoolId]).catch(() => {});
    }
    await pool.query(`DELETE FROM platform_audit_logs WHERE platform_admin_id = $1`, [superAdminUserId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]).catch(() => {});
    await pool.end();
  }, 20000);

  it('POST /onboarding → 201, returns session_id and school_id', async () => {
    const res = await request(app)
      .post('/api/super-admin/onboarding')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ school_name: 'Onboarding Wizard School', school_email: onboardingSchoolEmail });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.session_id).toBeDefined();
    expect(res.body.data.school_id).toBeDefined();
    sessionId = res.body.data.session_id;
    onboardingSchoolId = res.body.data.school_id;
  });

  it('PATCH step/1 (school info) → 200', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/onboarding/${sessionId}/step/1`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Onboarding Wizard School', address: '1 Wizard Lane', phone: '08012345678' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH step/2 (identity) → 200', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/onboarding/${sessionId}/step/2`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ motto: 'Wisdom Above All', primary_colour: '#336699' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH step/3 (calendar — 3 terms) → 200', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/onboarding/${sessionId}/step/3`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        session_name: '2025/2026',
        terms: [
          { name: 'First Term',  start_date: '2025-09-08', end_date: '2025-12-12' },
          { name: 'Second Term', start_date: '2026-01-05', end_date: '2026-04-03' },
          { name: 'Third Term',  start_date: '2026-04-27', end_date: '2026-07-24' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH step/4 (grading — valid grade bands) → 200', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/onboarding/${sessionId}/step/4`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        grades: [
          { label: 'A', min: 70, max: 100, remark: 'Excellent' },
          { label: 'B', min: 60, max: 69,  remark: 'Very Good' },
          { label: 'C', min: 50, max: 59,  remark: 'Good'      },
          { label: 'D', min: 40, max: 49,  remark: 'Pass'      },
          { label: 'F', min: 0,  max: 39,  remark: 'Fail'      },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH step/5 (assessment — components summing to 100%) → 200', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/onboarding/${sessionId}/step/5`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        components: [
          { name: 'CA 1',        max_score: 10, weight_percent: 30 },
          { name: 'Examination', max_score: 70, weight_percent: 70 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH step/6 (principal account) → 200, has temp_password', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/onboarding/${sessionId}/step/6`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ first_name: 'Wizard', last_name: 'Principal', email: principalEmail });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.temp_password).toBe('string');
    expect(res.body.data.temp_password.length).toBeGreaterThan(0);
  }, 20000);

  it('POST /complete → 200, school is_active: true', async () => {
    const res = await request(app)
      .post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ accepted_legal_terms: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.is_active).toBe(true);
  }, 30000);

  it('principal user exists in public.users with role=principal and correct school_id', async () => {
    const result = await pool.query<{ id: string; role: string; school_id: string }>(
      `SELECT id, role, school_id FROM users WHERE email = $1`,
      [principalEmail]
    );
    expect(result.rows[0]).toBeDefined();
    expect(result.rows[0].role).toBe('principal');
    expect(result.rows[0].school_id).toBe(onboardingSchoolId);
    principalUserId = result.rows[0].id;
  });

  it('completing an already-completed session → 409', async () => {
    const res = await request(app)
      .post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ accepted_legal_terms: true });
    expect(res.status).toBe(409);
  });
});
