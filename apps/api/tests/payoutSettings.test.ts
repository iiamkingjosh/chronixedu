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

// The PUT route now step-up-verifies the caller's password via
// supabase.auth.signInWithPassword (the exact mechanism login uses) before it
// will touch payout config. Mock it the same way src/__tests__/auth.test.ts
// does — default to "correct password", individual tests override to
// simulate a wrong one. supabaseAdmin is unused by the payout routes under
// test here, so it's left as an empty stub.
const mockSignInWithPassword = jest.fn().mockResolvedValue({ data: {}, error: null });
jest.mock('../src/supabaseClient', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
    },
  },
  supabaseAdmin: {},
}));

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import schoolsRouter from '../src/routes/schools';
import { verifyToken } from '../src/middleware/auth';
import { requireActiveSchool } from '../src/middleware/requireActiveSchool';
import { errorHandler } from '../src/middleware/errorHandler';
import { sendEmail } from '../src/services/emailService';
import { sendTermiiSms } from '../src/services/termiiService';
import { cache, schoolCacheKey } from '../src/services/cacheService';

const mockSendEmail = sendEmail as jest.Mock;
const mockSendTermiiSms = sendTermiiSms as jest.Mock;

const ROOT_ADMIN_EMAIL = 'root-admin-test@chronixedu-test.com';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
// requireFeature (inserted into the payout route chains) reads
// res.locals.school.subscription_tier, which only requireActiveSchool
// populates — mount it here too, matching production's app-level wiring
// (apps/api/src/index.ts), so the plan-gating tests below exercise the same
// path a real request takes.
app.use('/api/schools', requireActiveSchool);
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
  let principalEmail: string;
  let principalToken: string;
  // Second tenant — used to prove a bursar can't reach another school's payout routes.
  let otherSchoolId: string;
  let otherBursarToken: string;
  let otherPrincipalToken: string;
  const principalPhone = '+2348012345678';
  const schoolEmail = 'school-office@test.com';
  const CURRENT_PASSWORD = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    // Fixed, test-owned value so the ROOT_ADMIN_EMAIL alert leg is deterministic
    // regardless of what (if anything) is set in the real .env.
    process.env.ROOT_ADMIN_EMAIL = ROOT_ADMIN_EMAIL;

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active, email) VALUES ($1, $2, true, $3) RETURNING id`,
      ['Payout Test School', `test-payout-${randomUUID()}`, schoolEmail]
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject', FALSE)
       RETURNING id, email`,
      [schoolId, `bursar-${randomUUID()}@test.com`]
    );
    bursarUserId = bursarResult.rows[0].id;
    bursarToken = makeToken(bursarUserId, 'bursar', schoolId, bursarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Test', 'Teacher', 'subject', FALSE)
       RETURNING id, email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);

    // Principal — target of the fraud-alert fan-out (email + SMS). Needs a real
    // email/phone so the alert assertions in the PUT test can check real recipients.
    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, phone, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', $3, 'subject', FALSE)
       RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`, principalPhone]
    );
    principalEmail = principalResult.rows[0].email;
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalEmail);

    // A completely separate school with its own bursar. Its token carries the
    // right ROLE but the wrong school_id — the exact cross-tenant case.
    const otherSchoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active, email) VALUES ($1, $2, true, $3) RETURNING id`,
      ['Other Payout Test School', `test-payout-other-${randomUUID()}`, 'other-office@test.com']
    );
    otherSchoolId = otherSchoolResult.rows[0].id;

    const otherBursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Other', 'Bursar', 'subject', FALSE)
       RETURNING id, email`,
      [otherSchoolId, `other-bursar-${randomUUID()}@test.com`]
    );
    otherBursarToken = makeToken(otherBursarResult.rows[0].id, 'bursar', otherSchoolId, otherBursarResult.rows[0].email);

    const otherPrincipalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Other', 'Principal', 'subject', FALSE)
       RETURNING id, email`,
      [otherSchoolId, `other-principal-${randomUUID()}@test.com`]
    );
    otherPrincipalToken = makeToken(otherPrincipalResult.rows[0].id, 'principal', otherSchoolId, otherPrincipalResult.rows[0].email);
  });

  beforeEach(() => {
    mockSignInWithPassword.mockClear();
    mockSignInWithPassword.mockResolvedValue({ data: {}, error: null });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE school_id = ANY($1::uuid[])`, [[schoolId, otherSchoolId]]);
    await pool.query(`DELETE FROM users WHERE school_id = ANY($1::uuid[])`, [[schoolId, otherSchoolId]]);
    await pool.query(`DELETE FROM schools WHERE id = ANY($1::uuid[])`, [[schoolId, otherSchoolId]]);
    await pool.end();
  });

  it('rejects a teacher with 403', async () => {
    const res = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("rejects a bursar from a different school with 403 on every payout route", async () => {
    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${otherBursarToken}`);
    expect(getRes.status).toBe(403);
    expect(getRes.body.success).toBe(false);

    const resolveRes = await request(app)
      .post(`/api/schools/${schoolId}/settings/payout/resolve`)
      .set('Authorization', `Bearer ${otherBursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789' });
    expect(resolveRes.status).toBe(403);
    expect(resolveRes.body.success).toBe(false);

    const putRes = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${otherBursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL', current_password: CURRENT_PASSWORD });
    expect(putRes.status).toBe(403);
    expect(putRes.body.success).toBe(false);
  });

  it('rejects a bursar from their OWN school with 403 on PUT — bursar can read/resolve but never redirect settlement themselves', async () => {
    const putRes = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL', current_password: CURRENT_PASSWORD });

    expect(putRes.status).toBe(403);
    expect(putRes.body.success).toBe(false);
    // Never even reaches the step-up check — role is rejected first.
    expect(mockSignInWithPassword).not.toHaveBeenCalled();

    // Bursar retains read/resolve access on the other payout routes.
    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);
    expect(getRes.status).toBe(200);
  });

  it('returns 403 FEATURE_NOT_IN_PLAN for a basic-tier school on all four payout routes', async () => {
    await pool.query(`UPDATE schools SET subscription_tier = 'basic' WHERE id = $1`, [schoolId]);
    // requireActiveSchool caches the school row for 5 minutes; earlier requests
    // in this suite already primed that cache, so bust it or the stale
    // (pre-update) row would make requireFeature fail open.
    cache.del(schoolCacheKey(schoolId, 'data'));

    const getRes = await request(app).get(`/api/schools/${schoolId}/settings/payout`).set('Authorization', `Bearer ${bursarToken}`);
    expect(getRes.status).toBe(403);
    expect(getRes.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

    const banksRes = await request(app).get(`/api/schools/${schoolId}/settings/payout/banks`).set('Authorization', `Bearer ${bursarToken}`);
    expect(banksRes.status).toBe(403);

    const resolveRes = await request(app).post(`/api/schools/${schoolId}/settings/payout/resolve`).set('Authorization', `Bearer ${bursarToken}`).send({ bank_code: '058', account_number: '0123456789' });
    expect(resolveRes.status).toBe(403);

    // Use the principal token here — PUT is principal/super_admin-only now, so a
    // bursar token would 403 on the role check before ever reaching the plan
    // gate, which isn't what this test is verifying.
    const putRes = await request(app).put(`/api/schools/${schoolId}/settings/payout`).set('Authorization', `Bearer ${principalToken}`).send({ bank_code: '058', account_number: '0123456789', account_name: 'X', current_password: CURRENT_PASSWORD });
    expect(putRes.status).toBe(403);
    expect(putRes.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

    // Restore for any tests that run after this one in the same file.
    await pool.query(`UPDATE schools SET subscription_tier = 'premium' WHERE id = $1`, [schoolId]);
    cache.del(schoolCacheKey(schoolId, 'data'));
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

  it('saves payout config, creates a subaccount, masks the account number on re-fetch, logs an audit entry, and fires the 3-way fraud alert', async () => {
    mockSendEmail.mockClear();
    mockSendTermiiSms.mockClear();

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
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL', current_password: CURRENT_PASSWORD });

    expect(putRes.status).toBe(200);
    expect(mockSignInWithPassword).toHaveBeenCalledWith({ email: principalEmail, password: CURRENT_PASSWORD });

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

    // 3-way fraud alert: principal (email + SMS), the school's own office email,
    // and the platform root admin — each must actually fire, to the right
    // recipient, with content that identifies the changed account.
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    expect(mockSendEmail).toHaveBeenCalledWith(
      principalEmail,
      'Payout bank details changed',
      expect.stringContaining('6789')
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      schoolEmail,
      'Payout bank details changed',
      expect.stringContaining('6789')
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      ROOT_ADMIN_EMAIL,
      expect.stringContaining('Payout change'),
      expect.stringContaining('6789')
    );

    expect(mockSendTermiiSms).toHaveBeenCalledTimes(1);
    expect(mockSendTermiiSms).toHaveBeenCalledWith(
      schoolId,
      principalPhone,
      expect.stringContaining('6789')
    );
  });

  it('rejects the PUT with 401 when the step-up password is wrong, and never creates or activates a subaccount', async () => {
    mockSendEmail.mockClear();
    mockSignInWithPassword.mockResolvedValueOnce({ data: null, error: { message: 'Invalid login credentials' } });

    const createSubaccountSpy = jest.fn().mockResolvedValue({
      json: async () => ({ status: true, data: { subaccount_code: 'ACCT_should_not_be_created' } }),
    });
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '5555555555', account_name: 'WRONG PASSWORD SCHOOL' } }),
        });
      }
      return createSubaccountSpy(url);
    });

    const res = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ bank_code: '058', account_number: '5555555555', account_name: 'WRONG PASSWORD SCHOOL', current_password: 'not-the-real-password' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('STEP_UP_FAILED');

    // Fails before ever touching Paystack or sending the fraud alert — the
    // account on file must be completely untouched.
    expect(createSubaccountSpy).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();

    const getRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);
    expect(getRes.body.data.settlement_status).toBe('active');
    expect(getRes.body.data.account_number).toBe('••••6789');
  });

  it('rejects the PUT with 400 VALIDATION_ERROR when current_password is missing', async () => {
    const res = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'PAYOUT TEST SCHOOL' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('returns 424 and sets settlement_status failed when subaccount creation fails with no active config to protect', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '0000000000', account_name: 'FAIL SCHOOL' } }),
        });
      }
      return Promise.resolve({ json: async () => ({ status: false, message: 'Invalid account' }) });
    });

    // The second school has never configured payouts, so there is nothing to
    // preserve — the failed state is written.
    const res = await request(app)
      .put(`/api/schools/${otherSchoolId}/settings/payout`)
      .set('Authorization', `Bearer ${otherPrincipalToken}`)
      .send({ bank_code: '058', account_number: '0000000000', account_name: 'FAIL SCHOOL', current_password: CURRENT_PASSWORD });

    expect(res.status).toBe(424);

    const getRes = await request(app)
      .get(`/api/schools/${otherSchoolId}/settings/payout`)
      .set('Authorization', `Bearer ${otherBursarToken}`);
    expect(getRes.body.data.settlement_status).toBe('failed');

    // The failed attempt must not be invisible.
    const auditResult = await pool.query(
      `SELECT * FROM audit_logs WHERE school_id = $1 AND action_type = 'PAYOUT_CONFIG_CHANGE_FAILED' ORDER BY created_at DESC LIMIT 1`,
      [otherSchoolId]
    );
    expect(auditResult.rows.length).toBe(1);
    expect(auditResult.rows[0].new_value.existing_config_preserved).toBe(false);
  });

  it('preserves an ACTIVE payout config when subaccount creation fails, and audits the failed attempt', async () => {
    // The first school already has an active config from the save test above.
    const beforeRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);
    expect(beforeRes.body.data.settlement_status).toBe('active');

    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/bank/resolve')) {
        return Promise.resolve({
          json: async () => ({ status: true, data: { account_number: '9999999999', account_name: 'NEW BANK ACCOUNT' } }),
        });
      }
      return Promise.resolve({ json: async () => ({ status: false, message: 'Paystack is down' }) });
    });

    const res = await request(app)
      .put(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ bank_code: '058', account_number: '9999999999', account_name: 'NEW BANK ACCOUNT', current_password: CURRENT_PASSWORD });

    expect(res.status).toBe(424);

    // The working config — and therefore the school's ability to collect fees —
    // must survive a transient Paystack failure untouched.
    const afterRes = await request(app)
      .get(`/api/schools/${schoolId}/settings/payout`)
      .set('Authorization', `Bearer ${bursarToken}`);
    expect(afterRes.body.data.settlement_status).toBe('active');
    expect(afterRes.body.data.account_number).toBe('••••6789');
    expect(afterRes.body.data.account_name).toBe('PAYOUT TEST SCHOOL');

    const auditResult = await pool.query(
      `SELECT * FROM audit_logs WHERE school_id = $1 AND action_type = 'PAYOUT_CONFIG_CHANGE_FAILED' ORDER BY created_at DESC LIMIT 1`,
      [schoolId]
    );
    expect(auditResult.rows.length).toBe(1);
    expect(auditResult.rows[0].new_value.existing_config_preserved).toBe(true);
  });
});
