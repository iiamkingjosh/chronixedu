import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

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
import behaviourRouter from '../src/routes/behaviour';
import { errorHandler } from '../src/middleware/errorHandler';
import { processNotificationQueue } from '../src/services/notificationWorker';
import { sendTermiiSms } from '../src/services/termiiService';

const SCHOOL_ID  = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID   = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';

const app = express();
app.use(express.json());
app.use('/api/schools', behaviourRouter);
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

describe('Notification pipeline — suspension → audit log → worker → in-app + SMS', () => {
  const suffix = randomUUID().slice(0, 8);
  const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);

  let parentUserId: string;
  let studentUserId: string;
  let studentId: string;
  let behaviourRecordId: string;

  beforeAll(async () => {
    const parentResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, 'test-hash', 'parent', 'Notify', 'Parent', '+2348011111111')
       RETURNING id`,
      [SCHOOL_ID, `notify-parent-${suffix}@chronixedu-test.com`]
    );
    parentUserId = parentResult.rows[0].id;

    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'test-hash', 'student', 'Notify', 'Student')
       RETURNING id`,
      [SCHOOL_ID, `notify-student-${suffix}@chronixedu-test.com`]
    );
    studentUserId = studentUserResult.rows[0].id;

    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [SCHOOL_ID, studentUserId, `TEST-NOTIFY-${suffix}`]
    );
    studentId = studentResult.rows[0].id;

    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
       VALUES ($1, $2, 'mother', TRUE)`,
      [parentUserId, studentId]
    );
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM notification_logs WHERE user_id = $1`, [parentUserId]);
    await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [parentUserId]);
    await pool.query(`DELETE FROM audit_logs WHERE entity = 'behaviour_records' AND entity_id = $1`, [behaviourRecordId]);
    await pool.query(`DELETE FROM behaviour_records WHERE id = $1`, [behaviourRecordId]);
    await pool.query(`DELETE FROM parent_students WHERE parent_id = $1`, [parentUserId]);
    await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [parentUserId, studentUserId]);
    await pool.end();
  }, 20000);

  it(
    'logs a suspension incident, queues a parent notification, and the worker delivers it in-app and via SMS',
    async () => {
      // 1. Teacher logs a suspension-level behaviour incident
      const res = await request(app)
        .post(`/api/schools/${SCHOOL_ID}/behaviour`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          student_id: studentId,
          class_id: CLASS_ID,
          incident_type: 'Fighting',
          description: 'Physical altercation with another student',
          sanction: '3-day suspension',
          severity: 'suspension',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      behaviourRecordId = res.body.data.id;

      // 2. The parent-notification audit log entry is queued (logAudit is fire-and-forget)
      const auditRow = await waitFor(async () => {
        const result = await pool.query<{ id: string; processed_at: string | null }>(
          `SELECT id, processed_at FROM audit_logs
           WHERE entity = 'behaviour_records' AND entity_id = $1 AND action_type = 'PARENT_NOTIFICATION_SENT'`,
          [behaviourRecordId]
        );
        return result.rows[0] ?? null;
      });
      expect(auditRow).toBeTruthy();
      expect(auditRow.processed_at).toBeNull();

      // 3. The worker processes the queue
      for (let i = 0; i < 10; i++) {
        await processNotificationQueue();
        const result = await pool.query<{ processed_at: string | null }>(
          `SELECT processed_at FROM audit_logs WHERE id = $1`,
          [auditRow.id]
        );
        if (result.rows[0]?.processed_at) break;
      }

      const processedRow = await pool.query<{ processed_at: string | null }>(
        `SELECT processed_at FROM audit_logs WHERE id = $1`,
        [auditRow.id]
      );
      expect(processedRow.rows[0].processed_at).not.toBeNull();

      // 4. An in-app notification was created for the parent
      const notificationResult = await pool.query<{ type: string; title: string; body: string }>(
        `SELECT type, title, body FROM notifications WHERE user_id = $1 AND type = 'behaviour_incident'`,
        [parentUserId]
      );
      expect(notificationResult.rows).toHaveLength(1);
      expect(notificationResult.rows[0].title).toBe('Suspension notice');

      // 5. The Termii SMS provider was called for the parent's phone number
      expect(sendTermiiSms).toHaveBeenCalledWith(SCHOOL_ID, '+2348011111111', expect.any(String));

      // 6. The SMS delivery attempt was logged
      const logResult = await pool.query<{ status: string }>(
        `SELECT status FROM notification_logs WHERE user_id = $1 AND channel = 'sms'`,
        [parentUserId]
      );
      expect(logResult.rows).toHaveLength(1);
      expect(logResult.rows[0].status).toBe('sent');
    },
    30000
  );
});
