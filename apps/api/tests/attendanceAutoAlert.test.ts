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

const SCHOOL_ID  = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID   = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';

// Three consecutive dates within the seeded "First Term" (2025-08-31 .. 2025-12-20)
const ABSENT_DATES = ['2025-11-10', '2025-11-11', '2025-11-12'];

const app = express();
app.use(express.json());
app.use('/api/schools', attendanceRouter);
app.use(errorHandler);

function makeToken(role: string, schoolId: string, userId: string) {
  return jwt.sign(
    { user_id: userId, role, school_id: schoolId, email: 'teacher.math@chronixedu.com' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 10000, intervalMs = 200): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result !== null) return result;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

describe('Behaviour auto-alert — 3 consecutive absences → attendance_alert + queued notification', () => {
  const suffix = randomUUID().slice(0, 8);
  const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);

  let studentUserId: string;
  let studentId: string;
  let alertId: string;

  beforeAll(async () => {
    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'test-hash', 'student', 'Absent', 'Student')
       RETURNING id`,
      [SCHOOL_ID, `absent-student-${suffix}@chronixedu-test.com`]
    );
    studentUserId = studentUserResult.rows[0].id;

    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [SCHOOL_ID, studentUserId, `TEST-ABSENT-${suffix}`]
    );
    studentId = studentResult.rows[0].id;
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE entity = 'attendance_alerts' AND entity_id = $1`, [alertId]);
    await pool.query(`DELETE FROM attendance_alerts WHERE student_id = $1`, [studentId]);
    await pool.query(`DELETE FROM attendance WHERE student_id = $1`, [studentId]);
    await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [studentUserId]);
    await pool.end();
  }, 20000);

  it(
    'marking the student absent for 3 consecutive days creates an attendance_alert and queues a parent notification',
    async () => {
      let lastRes;
      for (const date of ABSENT_DATES) {
        lastRes = await request(app)
          .post(`/api/schools/${SCHOOL_ID}/attendance/mark`)
          .set('Authorization', `Bearer ${teacherToken}`)
          .send({ class_id: CLASS_ID, date, entries: [{ student_id: studentId, status: 'absent' }] });

        expect(lastRes.status).toBe(201);
        expect(lastRes.body.success).toBe(true);
      }

      // Only the 3rd day's marking should have triggered the alert (3+ absences in trailing 7 days)
      expect(lastRes!.body.data.alerts_triggered).toBe(1);
      expect(lastRes!.body.data.alerts).toHaveLength(1);
      alertId = lastRes!.body.data.alerts[0].id;

      // 1. attendance_alert row exists
      const alertResult = await pool.query<{ id: string; alert_type: string; is_resolved: boolean }>(
        `SELECT id, alert_type, is_resolved FROM attendance_alerts WHERE student_id = $1 AND school_id = $2`,
        [studentId, SCHOOL_ID]
      );
      expect(alertResult.rows).toHaveLength(1);
      expect(alertResult.rows[0].alert_type).toBe('low_attendance');
      expect(alertResult.rows[0].is_resolved).toBe(false);
      expect(alertResult.rows[0].id).toBe(alertId);

      // 2. parent notification was queued via audit_logs (logAudit is fire-and-forget)
      const auditRow = await waitFor(async () => {
        const result = await pool.query<{ id: string; new_value: { student_id: string; notification_type: string; recent_absences: number } }>(
          `SELECT id, new_value FROM audit_logs
           WHERE entity = 'attendance_alerts' AND entity_id = $1 AND action_type = 'PARENT_NOTIFICATION_QUEUED'`,
          [alertId]
        );
        return result.rows[0] ?? null;
      });
      expect(auditRow).toBeTruthy();
      expect(auditRow.new_value.student_id).toBe(studentId);
      expect(auditRow.new_value.notification_type).toBe('low_attendance');
      expect(auditRow.new_value.recent_absences).toBeGreaterThanOrEqual(3);
    },
    30000
  );
});
