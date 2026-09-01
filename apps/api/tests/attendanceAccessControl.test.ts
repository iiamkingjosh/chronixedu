import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import attendanceRouter from '../src/routes/attendance';
import { errorHandler } from '../src/middleware/errorHandler';

// ── Fixed test data (seeded by jest.globalSetup.ts) ───────────────────────────
// TEACHER_ID is the form_teacher_id of CLASS_ID (see jest.globalSetup.ts), so it
// is a legitimately-assigned teacher for CLASS_ID.
const SCHOOL_ID   = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID    = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID  = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';
const SESSION_ID  = 'e3e62132-16e4-4c1c-ad8b-9118579323c5';

const app = express();
app.use(express.json());
app.use('/api/schools', attendanceRouter);
app.use(errorHandler);

function makeToken(role: string, schoolId: string, userId: string) {
  return jwt.sign(
    { user_id: userId, role, school_id: schoolId, email: `${role}.accesscontrol@chronixedu-test.com` },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}

describe('Attendance access control', () => {
  const suffix = randomUUID().slice(0, 8);

  let studentUserId: string;
  let unassignedTeacherUserId: string;
  let unassignedClassId: string;

  beforeAll(async () => {
    // A student user — used to prove non-staff roles can't read rosters/summaries/alerts.
    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
       VALUES ($1, $2, 'test-hash', 'student', 'AccessControl', 'Student', FALSE)
       RETURNING id`,
      [SCHOOL_ID, `access-student-${suffix}@chronixedu-test.com`]
    );
    studentUserId = studentUserResult.rows[0].id;

    // A second teacher, not assigned to CLASS_ID and not its form teacher.
    const teacherUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Unassigned', 'Teacher', 'subject', FALSE)
       RETURNING id`,
      [SCHOOL_ID, `access-unassigned-teacher-${suffix}@chronixedu-test.com`]
    );
    unassignedTeacherUserId = teacherUserResult.rows[0].id;

    // A second class that unassignedTeacherUserId has no relationship to (no
    // teacher_assignments row, not the form teacher).
    const classResult = await pool.query<{ id: string }>(
      `INSERT INTO classes (school_id, name, level, stream, form_teacher_id)
       VALUES ($1, $2, 'Junior', null, null)
       RETURNING id`,
      [SCHOOL_ID, `Access Control Class ${suffix}`]
    );
    unassignedClassId = classResult.rows[0].id;
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM classes WHERE id = $1`, [unassignedClassId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [studentUserId, unassignedTeacherUserId]);
    await pool.end();
  }, 20000);

  // ── Bug 1: role gate on monthly-summary / class-summary / alerts ────────────

  describe.each([
    ['monthly-summary', () => request(app).get(`/api/schools/${SCHOOL_ID}/attendance/monthly-summary`).query({ class_id: CLASS_ID, month: 1, year: 2026 })],
    ['class-summary',   () => request(app).get(`/api/schools/${SCHOOL_ID}/attendance/class-summary`).query({ term_id: randomUUID() })],
    ['alerts',          () => request(app).get(`/api/schools/${SCHOOL_ID}/attendance/alerts`)],
  ] as const)('GET /:schoolId/attendance/%s', (_name, buildRequest) => {
    it('rejects a student with 403', async () => {
      const studentToken = makeToken('student', SCHOOL_ID, studentUserId);
      const res = await buildRequest().set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects a parent with 403', async () => {
      const parentToken = makeToken('parent', SCHOOL_ID, randomUUID());
      const res = await buildRequest().set('Authorization', `Bearer ${parentToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('allows a teacher through the role gate (no 403)', async () => {
      const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);
      const res = await buildRequest().set('Authorization', `Bearer ${teacherToken}`);
      expect(res.status).not.toBe(403);
    });
  });

  // ── Bug 2: teacher must be assigned to the class to mark attendance ─────────

  describe('POST /:schoolId/attendance/mark', () => {
    it('rejects a teacher who is not assigned to the class with 403', async () => {
      const unassignedToken = makeToken('teacher', SCHOOL_ID, unassignedTeacherUserId);
      const res = await request(app)
        .post(`/api/schools/${SCHOOL_ID}/attendance/mark`)
        .set('Authorization', `Bearer ${unassignedToken}`)
        .send({ class_id: unassignedClassId, date: '2025-11-05', entries: [{ student_id: randomUUID(), status: 'present' }] });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_ASSIGNED');

      const rows = await pool.query(
        `SELECT id FROM attendance WHERE class_id = $1 AND date = $2`,
        [unassignedClassId, '2025-11-05']
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('rejects entries for students not enrolled in the class, even for an assigned teacher', async () => {
      const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);
      const res = await request(app)
        .post(`/api/schools/${SCHOOL_ID}/attendance/mark`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ class_id: CLASS_ID, date: '2025-11-06', entries: [{ student_id: randomUUID(), status: 'present' }] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NO_ENROLLED_STUDENTS');
    });

    it('allows a properly assigned teacher (the form teacher) to mark attendance', async () => {
      const studentUserResult = await pool.query<{ id: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
         VALUES ($1, $2, 'test-hash', 'student', 'Enrolled', 'Student', FALSE)
         RETURNING id`,
        [SCHOOL_ID, `access-enrolled-student-${suffix}@chronixedu-test.com`]
      );
      const enrolledStudentUserId = studentUserResult.rows[0].id;

      const studentResult = await pool.query<{ id: string }>(
        `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
        [SCHOOL_ID, enrolledStudentUserId, `TEST-ACCESS-${suffix}`]
      );
      const enrolledStudentId = studentResult.rows[0].id;

      await pool.query(
        `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
        [enrolledStudentId, CLASS_ID, SESSION_ID]
      );

      try {
        const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);
        const res = await request(app)
          .post(`/api/schools/${SCHOOL_ID}/attendance/mark`)
          .set('Authorization', `Bearer ${teacherToken}`)
          .send({ class_id: CLASS_ID, date: '2025-11-07', entries: [{ student_id: enrolledStudentId, status: 'present' }] });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.saved).toHaveLength(1);
      } finally {
        await pool.query(`DELETE FROM attendance WHERE student_id = $1`, [enrolledStudentId]);
        await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [enrolledStudentId]);
        await pool.query(`DELETE FROM students WHERE id = $1`, [enrolledStudentId]);
        await pool.query(`DELETE FROM users WHERE id = $1`, [enrolledStudentUserId]);
      }
    });

    it('allows a principal to mark attendance for any class without an assignment check', async () => {
      const principalUserResult = await pool.query<{ id: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
         VALUES ($1, $2, 'test-hash', 'principal', 'Access', 'Principal', FALSE)
         RETURNING id`,
        [SCHOOL_ID, `access-principal-${suffix}@chronixedu-test.com`]
      );
      const principalUserId = principalUserResult.rows[0].id;

      const studentUserResult = await pool.query<{ id: string }>(
        `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
         VALUES ($1, $2, 'test-hash', 'student', 'Principal', 'Marked', FALSE)
         RETURNING id`,
        [SCHOOL_ID, `access-principal-student-${suffix}@chronixedu-test.com`]
      );
      const principalStudentUserId = studentUserResult.rows[0].id;

      const studentResult = await pool.query<{ id: string }>(
        `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
        [SCHOOL_ID, principalStudentUserId, `TEST-PRINCIPAL-${suffix}`]
      );
      const principalStudentId = studentResult.rows[0].id;

      await pool.query(
        `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
        [principalStudentId, CLASS_ID, SESSION_ID]
      );

      try {
        const principalToken = makeToken('principal', SCHOOL_ID, principalUserId);
        const res = await request(app)
          .post(`/api/schools/${SCHOOL_ID}/attendance/mark`)
          .set('Authorization', `Bearer ${principalToken}`)
          .send({ class_id: CLASS_ID, date: '2025-11-08', entries: [{ student_id: principalStudentId, status: 'present' }] });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
      } finally {
        await pool.query(`DELETE FROM audit_logs WHERE user_id = $1`, [principalUserId]);
        await pool.query(`DELETE FROM attendance WHERE student_id = $1`, [principalStudentId]);
        await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [principalStudentId]);
        await pool.query(`DELETE FROM students WHERE id = $1`, [principalStudentId]);
        await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [principalStudentUserId, principalUserId]);
      }
    });
  });
});
