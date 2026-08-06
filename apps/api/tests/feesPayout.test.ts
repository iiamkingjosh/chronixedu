import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import feesRouter from '../src/routes/fees';
import { verifyToken } from '../src/middleware/auth';
import { requireActiveSchool } from '../src/middleware/requireActiveSchool';
import { errorHandler } from '../src/middleware/errorHandler';
import { cache, schoolCacheKey } from '../src/services/cacheService';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
// requireFeature (inserted into the Paystack-initiate chain) reads
// res.locals.school.subscription_tier, which only requireActiveSchool
// populates — mount it here too, matching production's app-level wiring
// (apps/api/src/index.ts), so the plan-gating test below exercises the same
// path a real request takes.
app.use('/api/schools', requireActiveSchool);
app.use('/api/schools', feesRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Fee payment initiate — payout gate', () => {
  let schoolId: string;
  let studentId: string;
  let parentUserId: string;
  let parentToken: string;
  let invoiceId: string;

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Fees Payout Test School', `test-fees-payout-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const parentResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'parent', 'Test', 'Parent', 'subject')
       RETURNING id, email`,
      [schoolId, `parent-${randomUUID()}@test.com`]
    );
    parentUserId = parentResult.rows[0].id;
    parentToken = makeToken(parentUserId, 'parent', schoolId, parentResult.rows[0].email);

    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'student', 'Test', 'Student', 'subject')
       RETURNING id`,
      [schoolId, `student-${randomUUID()}@test.com`]
    );

    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no)
       VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentUserResult.rows[0].id, `TEST-${randomUUID()}`]
    );
    studentId = studentResult.rows[0].id;

    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
       VALUES ($1, $2, 'mother', TRUE)`,
      [parentUserId, studentId]
    );

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, NOW(), NOW() + interval '365 days', false) RETURNING id`,
      [schoolId, `Test Session ${randomUUID()}`]
    );

    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (session_id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, 'Test Term', NOW(), NOW() + interval '30 days', false) RETURNING id`,
      [sessionResult.rows[0].id, schoolId]
    );

    const invoiceResult = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`,
      [schoolId, studentId, termResult.rows[0].id]
    );
    invoiceId = invoiceResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM fee_invoices WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM parent_students WHERE parent_id = $1`, [parentUserId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  });

  it('blocks payment with PAYOUT_NOT_CONFIGURED when the school has no active payout config', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ invoice_id: invoiceId });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYOUT_NOT_CONFIGURED');
  });

  it('initializes payment with subaccount and bearer when payout config is active', async () => {
    await pool.query(
      `UPDATE schools SET payout_config = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ paystack_subaccount_code: 'ACCT_test123', settlement_status: 'active' }), schoolId]
    );
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'ref-abc' },
      }),
    });

    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ invoice_id: invoiceId });

    expect(res.status).toBe(200);
    expect(res.body.data.authorization_url).toBe('https://checkout.paystack.com/abc');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        body: expect.stringContaining('"subaccount":"ACCT_test123"'),
      })
    );
  });

  it('returns 403 FEATURE_NOT_IN_PLAN when the school is on basic, even with an active payout config', async () => {
    await pool.query(`UPDATE schools SET subscription_tier = 'basic' WHERE id = $1`, [schoolId]);
    // requireActiveSchool caches the school row for 5 minutes; the earlier
    // requests in this suite already primed that cache, so bust it or the
    // stale (pre-update) row would make requireFeature fail open.
    cache.del(schoolCacheKey(schoolId, 'data'));

    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ invoice_id: invoiceId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

    await pool.query(`UPDATE schools SET subscription_tier = 'premium' WHERE id = $1`, [schoolId]);
    cache.del(schoolCacheKey(schoolId, 'data'));
  });
});
