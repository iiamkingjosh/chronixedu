import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

// This suite makes several real round trips to the DB per test; bump past the
// 5000ms default so transient network latency doesn't produce false failures.
jest.setTimeout(30000);

// The one external call this route makes is supabaseAdmin.auth.admin
// .updateUserById — mock that so the test suite never touches real Supabase.
const mockUpdateUserById = jest.fn().mockResolvedValue({ data: {}, error: null });
jest.mock('../src/supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: {
    auth: {
      admin: {
        updateUserById: (...args: unknown[]) => mockUpdateUserById(...args),
      },
    },
  },
}));

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import pool from '../src/db/client';
import usersRouter from '../src/routes/users';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', usersRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('PATCH /:schoolId/users/:userId/email', () => {
  let schoolId: string;
  let principalUserId: string;
  let principalEmail: string;
  let superAdminUserId: string;
  let superAdminToken: string;
  let principalToken: string;
  let teacherToken: string;
  let otherUserEmail: string;
  // A second, unrelated school + user — proves the route is properly school-scoped
  // and can't be used to reach an account that belongs to a different tenant.
  let otherSchoolId: string;
  let otherSchoolUserId: string;
  // A super_admin whose school_id is NOT null (school-scoped admin, a real
  // configuration this codebase supports — see auth.ts's create-user flow).
  // Reassigning this account must be blocked regardless of its school_id.
  let scopedSuperAdminId: string;

  const trackedUserIds: string[] = [];

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Email Change Test School', `test-email-change-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const otherSchoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Email Change Test School (Other Tenant)', `test-email-change-other-${randomUUID()}`]
    );
    otherSchoolId = otherSchoolResult.rows[0].id;

    const superAdminResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES (NULL, $1, 'test-hash', 'super_admin', 'Root', 'Admin', 'subject', FALSE)
       RETURNING id, email`,
      [`root-${randomUUID()}@test.com`]
    );
    superAdminUserId = superAdminResult.rows[0].id;
    superAdminToken = makeToken(superAdminUserId, 'super_admin', null, superAdminResult.rows[0].email);
    trackedUserIds.push(superAdminUserId);

    const scopedSuperAdminResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'super_admin', 'Scoped', 'Admin', 'subject', FALSE)
       RETURNING id`,
      [schoolId, `scoped-admin-${randomUUID()}@test.com`]
    );
    scopedSuperAdminId = scopedSuperAdminResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Departing', 'Principal', 'subject', FALSE)
       RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`]
    );
    principalUserId = principalResult.rows[0].id;
    principalEmail = principalResult.rows[0].email;
    principalToken = makeToken(principalUserId, 'principal', schoolId, principalEmail);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Test', 'Teacher', 'subject', FALSE)
       RETURNING id, email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);

    const otherResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Someone', 'Else', 'subject', FALSE)
       RETURNING email`,
      [schoolId, `taken-${randomUUID()}@test.com`]
    );
    otherUserEmail = otherResult.rows[0].email;

    const otherSchoolUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Other', 'Principal', 'subject', FALSE)
       RETURNING id`,
      [otherSchoolId, `other-tenant-principal-${randomUUID()}@test.com`]
    );
    otherSchoolUserId = otherSchoolUserResult.rows[0].id;
  }, 30000);

  afterEach(() => {
    mockUpdateUserById.mockClear();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE school_id = ANY($1::uuid[])`, [[schoolId, otherSchoolId]]);
    await pool.query(`DELETE FROM users WHERE school_id = ANY($1::uuid[])`, [[schoolId, otherSchoolId]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [trackedUserIds]);
    await pool.query(`DELETE FROM schools WHERE id = ANY($1::uuid[])`, [[schoolId, otherSchoolId]]);
    await pool.end();
  }, 30000);

  it('super_admin changes a principal\'s email to hand the account to a new hire, and rotates the password', async () => {
    const newEmail = `new-principal-${randomUUID()}@test.com`;
    const beforeHash = (await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [principalUserId])).rows[0].password_hash;

    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: newEmail, reason: 'Principal resigned, replaced by new hire' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(newEmail);

    const row = await pool.query<{ email: string; password_hash: string }>(`SELECT email, password_hash FROM users WHERE id = $1`, [principalUserId]);
    expect(row.rows[0].email).toBe(newEmail);
    // The old holder's known password must no longer work — the local shadow
    // copy has to change too, not just the Supabase side.
    expect(row.rows[0].password_hash).not.toBe(beforeHash);

    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
    const [calledId, calledAttrs] = mockUpdateUserById.mock.calls[0];
    expect(calledId).toBe(principalUserId);
    expect(calledAttrs.email).toBe(newEmail);
    expect(calledAttrs.email_confirm).toBe(true);
    // A fresh, non-empty throwaway password must be set on the Supabase side too —
    // this is exactly the fix for "old holder still knows the password".
    expect(typeof calledAttrs.password).toBe('string');
    expect(calledAttrs.password.length).toBeGreaterThan(0);
    // And it must be the *same* secret written to the local shadow copy —
    // not two different random values that leave the two stores out of sync.
    expect(bcrypt.compareSync(calledAttrs.password, row.rows[0].password_hash)).toBe(true);

    const audit = await pool.query<{ action_type: string; old_value: { email: string; role: string }; new_value: { email: string; reason: string } }>(
      `SELECT action_type, old_value, new_value FROM audit_logs
       WHERE entity = 'users' AND entity_id = $1 AND action_type = 'USER_EMAIL_CHANGED'
       ORDER BY created_at DESC LIMIT 1`,
      [principalUserId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].old_value.email).toBe(principalEmail);
    expect(audit.rows[0].old_value.role).toBe('principal');
    expect(audit.rows[0].new_value.email).toBe(newEmail);
    expect(audit.rows[0].new_value.reason).toBe('Principal resigned, replaced by new hire');
  });

  it('lowercases and trims the new email', async () => {
    const target = `Case-Test-${randomUUID()}@Test.com`;
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: `  ${target}  `, reason: 'Normalizing email casing test' });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(target.toLowerCase());

    // Re-submitting the same account's own (now-current) address in different
    // casing is a no-op on the target user, not a duplicate of itself.
    const same = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: target.toUpperCase(), reason: 'Re-submitting own address in different casing' });
    expect(same.status).toBe(200);
  });

  it('catches a case-variant duplicate against a different user\'s email', async () => {
    // otherUserEmail belongs to a different account entirely — sending it back
    // in upper case, targeting the principal, must still be caught as a
    // collision, not slip through because the casing differs from what's stored.
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: otherUserEmail.toUpperCase(), reason: 'Attempting a case-variant collision' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_EMAIL');
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('rejects a principal (non-super_admin) with 403', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ email: `x-${randomUUID()}@test.com`, reason: 'trying to escalate' });

    expect(res.status).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('rejects a teacher with 403', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ email: `x-${randomUUID()}@test.com`, reason: 'trying to escalate' });

    expect(res.status).toBe(403);
  });

  it('returns 400 VALIDATION_ERROR when reason is missing', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: `x-${randomUUID()}@test.com` });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR for an invalid email', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'not-an-email', reason: 'Principal resigned, replaced by new hire' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for a user that does not exist in this school', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${randomUUID()}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: `x-${randomUUID()}@test.com`, reason: 'Principal resigned, replaced by new hire' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when the user exists but belongs to a different school', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${otherSchoolUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: `x-${randomUUID()}@test.com`, reason: 'Principal resigned, replaced by new hire' });

    expect(res.status).toBe(404);
    expect(mockUpdateUserById).not.toHaveBeenCalled();

    const row = await pool.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [otherSchoolUserId]);
    expect(row.rows).toHaveLength(1); // untouched
  });

  it('returns 403 and refuses to reassign a super_admin account, even a school-scoped one', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${scopedSuperAdminId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: `x-${randomUUID()}@test.com`, reason: 'Attempting to take over a peer admin account' });

    expect(res.status).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('returns 409 DUPLICATE_EMAIL when the new email is already in use', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: otherUserEmail, reason: 'Principal resigned, replaced by new hire' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_EMAIL');
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('returns 500 AUTH_UPDATE_FAILED and leaves the local row completely untouched when Supabase update fails', async () => {
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { message: 'supabase down' } });
    const before = (await pool.query<{ email: string; password_hash: string }>(`SELECT email, password_hash FROM users WHERE id = $1`, [principalUserId])).rows[0];
    const newEmail = `should-not-apply-${randomUUID()}@test.com`;

    const res = await request(app)
      .patch(`/api/schools/${schoolId}/users/${principalUserId}/email`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: newEmail, reason: 'Principal resigned, replaced by new hire' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AUTH_UPDATE_FAILED');

    const after = await pool.query<{ email: string; password_hash: string }>(`SELECT email, password_hash FROM users WHERE id = $1`, [principalUserId]);
    // The local write happens inside a transaction that only commits after
    // Supabase confirms success — a Supabase failure must roll it back
    // completely, not just leave the email looking unchanged.
    expect(after.rows[0].email).toBe(before.email);
    expect(after.rows[0].password_hash).toBe(before.password_hash);

    const audit = await pool.query(
      `SELECT id FROM audit_logs WHERE entity = 'users' AND entity_id = $1 AND action_type = 'USER_EMAIL_CHANGED' AND new_value->>'email' = $2`,
      [principalUserId, newEmail]
    );
    expect(audit.rows).toHaveLength(0); // no audit row for a change that never actually happened
  });
});
