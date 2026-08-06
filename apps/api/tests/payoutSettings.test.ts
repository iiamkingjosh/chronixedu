import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

// Payout config changes fan out email/SMS alerts (3-way fraud alert). Mock these
// so the test suite doesn't make real SendGrid/Termii network calls.
jest.mock('../src/services/termiiService', () => ({
  isSmsConfigured: jest.fn().mockReturnValue(true),
  sendTermiiSms: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/services/emailService', () => ({
  isEmailConfigured: jest.fn().mockReturnValue(true),
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import schoolsRouter from '../src/routes/schools';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', schoolsRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Payout settings', () => {
  let schoolId: string;
  let bursarUserId: string;
  let bursarToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active, email) VALUES ($1, $2, true, $3) RETURNING id`,
      ['Payout Test School', `test-payout-${randomUUID()}`, 'school-office@test.com']
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject')
       RETURNING id, email`,
      [schoolId, `bursar-${randomUUID()}@test.com`]
    );
    bursarUserId = bursarResult.rows[0].id;
    bursarToken = makeToken(bursarUserId, 'bursar', schoolId, bursarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Test', 'Teacher', 'subject')
       RETURNING id, email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  });

  it('rejects a teacher with 403', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns settlement_status pending with no config saved yet', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.settlement_status).toBe('pending');
    expect(res.body.data.account_number).toBeUndefined();
  });

  it('resolves a bank account via Paystack', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: true, data: { account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' } }),
    });

    const res = await request(app)
      .post(`/api/schools/${schoolId}/settings/payout/resolve`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789' });

    expect(res.status).toBe(200);
    expect(res.body.data.account_name).toBe('PAYOUT TEST SCHOOL');
  });

  it('saves payout config, creates a subaccount, masks the account number on re-fetch, and logs an audit entry', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' } }),
        });
      }
      return Promise.resolve({
        json: async () => ({ status: true, data: { subaccount_code: 'ACCT_test123' } }),
      });
    });

    const putRes = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' });

    expect(putRes.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);

    expect(getRes.body.data.settlement_status).toBe('active');
    expect(getRes.body.data.account_number).toBe('••••6789');

    const auditResult = await pool.query(
      `SELECT * FROM audit_logs WHERE school_id = $1 AND action_type = 'PAYOUT_CONFIG_CHANGE' ORDER BY created_at DESC LIMIT 1`,
      [schoolId]
    );
    expect(auditResult.rows.length).toBe(1);
  });

  it('returns 502 and sets settlement_status failed when subaccount creation fails', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '0000000000', account_name: 'FAIL SCHOOL' } }),
        });
      }
      return Promise.resolve({ json: async () => ({ status: false, message: 'Invalid account' }) });
    });

    const res = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0000000000', account_name: 'FAIL SCHOOL' });

    expect(res.status).toBe(502);

    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);
    expect(getRes.body.data.settlement_status).toBe('failed');
  });
});
