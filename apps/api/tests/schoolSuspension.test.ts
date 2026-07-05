import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import superAdminRouter from '../src/routes/superAdmin';
import schoolsRouter from '../src/routes/schools';
import { detectSupportSession } from '../src/middleware/detectSupportSession';
import { verifyToken } from '../src/middleware/auth';
import { requireActiveSchool } from '../src/middleware/requireActiveSchool';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use('/api/schools', detectSupportSession);
app.use('/api/schools', verifyToken);
app.use('/api/schools', requireActiveSchool);
app.use('/api/schools', schoolsRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('School Suspension', () => {
  let superAdminUserId: string;
  let superAdminToken: string;
  let schoolId: string;
  let principalUserId: string;
  let principalToken: string;

  beforeAll(async () => {
    const saResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES (NULL, $1, 'test-hash', 'super_admin', 'Suspension', 'Admin', 'subject')
       RETURNING id`,
      [`suspension-admin-${randomUUID()}@test.com`]
    );
    superAdminUserId = saResult.rows[0].id;
    const saRow = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [superAdminUserId]);
    superAdminToken = makeToken(superAdminUserId, 'super_admin', null, saRow.rows[0].email);

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Suspension Test School', `test-suspension-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    await pool.query(
      `INSERT INTO school_settings (school_id, identity_config, academic_config, notification_config, report_config)
       VALUES (
         $1,
         '{"name":"Suspension Test School","motto":"","logo_url":null,"stamp_url":null,"primary_colour":null,"secondary_colour":null}'::jsonb,
         '{"promotion_cutoff":40,"grading_scale":[],"assessment_components":[]}'::jsonb,
         '{}'::jsonb,
         '{"template":"classic","show_attendance":true}'::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [schoolId]
    );

    const pResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject')
       RETURNING id`,
      [schoolId, `suspension-principal-${randomUUID()}@test.com`]
    );
    principalUserId = pResult.rows[0].id;
    const pRow = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [principalUserId]);
    principalToken = makeToken(principalUserId, 'principal', schoolId, pRow.rows[0].email);
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM platform_audit_logs WHERE target_school_id = $1`, [schoolId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [principalUserId]).catch(() => {});
    await pool.query(`DELETE FROM platform_audit_logs WHERE platform_admin_id = $1`, [superAdminUserId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]).catch(() => {});
    await pool.query(`DELETE FROM school_settings WHERE school_id = $1`, [schoolId]).catch(() => {});
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]).catch(() => {});
    await pool.end();
  }, 20000);

  it('principal can access an active school → 200', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}`)
      .set('Authorization', `Bearer ${principalToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH /super-admin/schools/:schoolId/suspend → 200, is_active false', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${schoolId}/suspend`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'Suspension integration test' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.is_active).toBe(false);
  });

  it('principal token while suspended → GET /api/schools/:schoolId → 403 SCHOOL_SUSPENDED', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}`)
      .set('Authorization', `Bearer ${principalToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCHOOL_SUSPENDED');
  });

  it('super_admin can still access a suspended school → 200', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PATCH /super-admin/schools/:schoolId/reactivate → 200, is_active true', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/schools/${schoolId}/reactivate`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'Suspension integration test reactivation' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.is_active).toBe(true);
  });

  it('principal can access the reactivated school → 200', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}`)
      .set('Authorization', `Bearer ${principalToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
