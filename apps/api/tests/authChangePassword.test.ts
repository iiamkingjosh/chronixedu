import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

// This suite makes several real round trips to the DB per test; bump past the
// 5000ms default so transient network latency doesn't produce false failures.
jest.setTimeout(30000);

// The one external call this route makes is supabase.auth.signInWithPassword
// (used by /login, not exercised here) and supabaseAdmin.auth.admin
// .updateUserById — mock both so the suite never touches real Supabase.
const mockUpdateUserById = jest.fn().mockResolvedValue({ data: {}, error: null });
jest.mock('../src/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: jest.fn() } },
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
import authRouter from '../src/routes/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('POST /api/auth/change-password', () => {
  let schoolId: string;
  let userId: string;
  let userToken: string;
  const CURRENT_PASSWORD = 'temp-Password123';

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Change Password Test School', `test-change-password-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const passwordHash = bcrypt.hashSync(CURRENT_PASSWORD, 10);
    const userResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, $3, 'principal', 'Test', 'Principal', 'subject', TRUE)
       RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`, passwordHash]
    );
    userId = userResult.rows[0].id;
    userToken = makeToken(userId, 'principal', schoolId, userResult.rows[0].email);
  }, 30000);

  afterEach(() => {
    mockUpdateUserById.mockClear();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  }, 30000);

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ current_password: CURRENT_PASSWORD, new_password: 'brand-new-Password456' });

    expect(res.status).toBe(401);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('rejects the wrong current password with 401 and never calls Supabase', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ current_password: 'totally-wrong', new_password: 'brand-new-Password456' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(mockUpdateUserById).not.toHaveBeenCalled();

    const row = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    expect(bcrypt.compareSync(CURRENT_PASSWORD, row.rows[0].password_hash)).toBe(true);
  });

  it('rejects a new password identical to the current one with 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ current_password: CURRENT_PASSWORD, new_password: CURRENT_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('rejects a new password shorter than 8 characters with 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ current_password: CURRENT_PASSWORD, new_password: 'short' });

    expect(res.status).toBe(400);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('changes the password, clears must_change_password, and writes the same secret to Supabase and the local hash', async () => {
    const newPassword = 'brand-new-Password456';

    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ current_password: CURRENT_PASSWORD, new_password: newPassword });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = await pool.query<{ password_hash: string; must_change_password: boolean }>(
      `SELECT password_hash, must_change_password FROM users WHERE id = $1`,
      [userId]
    );
    expect(row.rows[0].must_change_password).toBe(false);
    expect(bcrypt.compareSync(newPassword, row.rows[0].password_hash)).toBe(true);
    // The old password must no longer validate against the stored hash.
    expect(bcrypt.compareSync(CURRENT_PASSWORD, row.rows[0].password_hash)).toBe(false);

    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
    const [calledId, calledAttrs] = mockUpdateUserById.mock.calls[0];
    expect(calledId).toBe(userId);
    expect(calledAttrs.password).toBe(newPassword);

    const audit = await pool.query(
      `SELECT id FROM audit_logs WHERE entity = 'users' AND entity_id = $1 AND action_type = 'PASSWORD_SELF_CHANGE'`,
      [userId]
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('returns 500 PASSWORD_UPDATE_FAILED and leaves the local row untouched when Supabase update fails', async () => {
    // Reset this user's password back to a known value for this test.
    const knownPassword = 'known-Password789';
    await pool.query(`UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2`, [
      bcrypt.hashSync(knownPassword, 10),
      userId,
    ]);
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { message: 'supabase down' } });
    const before = (await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId])).rows[0];

    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ current_password: knownPassword, new_password: 'never-applied-Password000' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PASSWORD_UPDATE_FAILED');

    const after = await pool.query<{ password_hash: string; must_change_password: boolean }>(
      `SELECT password_hash, must_change_password FROM users WHERE id = $1`,
      [userId]
    );
    // The local write happens inside a transaction that only commits after
    // Supabase confirms success — a Supabase failure must roll it back
    // completely, including must_change_password.
    expect(after.rows[0].password_hash).toBe(before.password_hash);
    expect(after.rows[0].must_change_password).toBe(true);
  });
});
