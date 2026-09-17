import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import sessionsRouter from '../src/routes/sessions';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', sessionsRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

// Regression coverage for a real gap found in this pass: there was no way to
// ever set terms.is_current = TRUE anywhere in the system, so every feature
// that defaults to "the active term" (timetable, scores, attendance, results)
// silently rendered empty for every school, forever.
describe('Term activation', () => {
  const suffix = randomUUID().slice(0, 8);
  let schoolId: string;
  let sessionId: string;
  let otherSessionId: string;
  let termAId: string;
  let termBId: string;
  let principalToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ('Term Activation Test', $1, true) RETURNING id`,
      [`term-activation-${suffix}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', FALSE) RETURNING id, email`,
      [schoolId, `principal-${suffix}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Test', 'Teacher', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `teacher-${suffix}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2026/2027', '2026-09-01', '2027-07-31', true) RETURNING id`,
      [schoolId]
    );
    sessionId = sessionResult.rows[0].id;

    const otherSessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2025/2026', '2025-09-01', '2026-07-31', false) RETURNING id`,
      [schoolId]
    );
    otherSessionId = otherSessionResult.rows[0].id;

    const termAResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (session_id, school_id, name, start_date, end_date)
       VALUES ($1, $2, 'First Term', '2026-09-01', '2026-12-18') RETURNING id`,
      [sessionId, schoolId]
    );
    termAId = termAResult.rows[0].id;

    const termBResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (session_id, school_id, name, start_date, end_date)
       VALUES ($1, $2, 'Second Term', '2027-01-05', '2027-04-02') RETURNING id`,
      [sessionId, schoolId]
    );
    termBId = termBResult.rows[0].id;
  }, 30000);

  afterAll(async () => {
    await Promise.race([
      pool.end(),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }, 15000);

  it('rejects a teacher (not principal/super_admin)', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/sessions/${sessionId}/terms/${termAId}/activate`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ confirm: true });

    expect(res.status).toBe(403);
  }, 20000);

  it('requires { confirm: true } in the body', async () => {
    const res = await request(app)
      .patch(`/api/schools/${schoolId}/sessions/${sessionId}/terms/${termAId}/activate`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
  }, 20000);

  it('rejects activating a term whose session is not the current session', async () => {
    const termInOtherSessionResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (session_id, school_id, name, start_date, end_date)
       VALUES ($1, $2, 'Old Term', '2025-09-01', '2025-12-18') RETURNING id`,
      [otherSessionId, schoolId]
    );

    const res = await request(app)
      .patch(`/api/schools/${schoolId}/sessions/${otherSessionId}/terms/${termInOtherSessionResult.rows[0].id}/activate`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_CURRENT');
  }, 20000);

  it('activates a term, and current-context resolves it', async () => {
    const activateRes = await request(app)
      .patch(`/api/schools/${schoolId}/sessions/${sessionId}/terms/${termAId}/activate`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ confirm: true });

    expect(activateRes.status).toBe(200);

    const dbRow = await pool.query<{ is_current: boolean }>(
      `SELECT is_current FROM terms WHERE id = $1`,
      [termAId]
    );
    expect(dbRow.rows[0].is_current).toBe(true);

    const ctxRes = await request(app)
      .get(`/api/schools/${schoolId}/current-context`)
      .set('Authorization', `Bearer ${principalToken}`);

    expect(ctxRes.status).toBe(200);
    expect(ctxRes.body.data.term.id).toBe(termAId);
  }, 20000);

  it('switches the current term within the same session, clearing the previous one', async () => {
    const activateRes = await request(app)
      .patch(`/api/schools/${schoolId}/sessions/${sessionId}/terms/${termBId}/activate`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ confirm: true });

    expect(activateRes.status).toBe(200);

    const rows = await pool.query<{ id: string; is_current: boolean }>(
      `SELECT id, is_current FROM terms WHERE session_id = $1 ORDER BY start_date`,
      [sessionId]
    );
    const termA = rows.rows.find(r => r.id === termAId);
    const termB = rows.rows.find(r => r.id === termBId);
    expect(termA?.is_current).toBe(false);
    expect(termB?.is_current).toBe(true);

    const ctxRes = await request(app)
      .get(`/api/schools/${schoolId}/current-context`)
      .set('Authorization', `Bearer ${principalToken}`);
    expect(ctxRes.body.data.term.id).toBe(termBId);
  }, 20000);
});
