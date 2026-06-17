import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import 'fake-indexeddb/auto';
import { randomUUID } from 'crypto';
import Dexie, { Table } from 'dexie';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import attendanceRouter from '../src/routes/attendance';
import { errorHandler } from '../src/middleware/errorHandler';

// ── Fixed test data (seeded by jest.globalSetup.ts) ───────────────────────────
const SCHOOL_ID  = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID   = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';

// Date within the seeded "First Term" (2025-08-31 .. 2025-12-20), unused by other fixtures
const QUEUED_DATE = '2025-11-03';

// ── Local replica of apps/web/lib/offlineDb.ts's offline_attendance_queue ─────

interface OfflineAttendanceEntry {
  id?: number;
  school_id: string;
  class_id: string;
  date: string;
  entries: { student_id: string; status: string }[];
  queued_at: string;
}

class ChronixOfflineTestDB extends Dexie {
  offline_attendance_queue!: Table<OfflineAttendanceEntry, number>;

  constructor() {
    super('chronixedu_offline_test');
    this.version(1).stores({
      offline_attendance_queue: '++id, school_id, class_id, date',
    });
  }
}

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

describe('Offline sync — Dexie queue → reconnect → database', () => {
  const suffix = randomUUID().slice(0, 8);
  const offlineDb = new ChronixOfflineTestDB();
  const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);

  let studentUserId: string;
  let studentId: string;

  beforeAll(async () => {
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'test-hash', 'student', 'Offline', 'Sync')
       RETURNING id`,
      [SCHOOL_ID, `offline-sync-${suffix}@chronixedu-test.com`]
    );
    studentUserId = userResult.rows[0].id;

    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [SCHOOL_ID, studentUserId, `TEST-OFFLINE-${suffix}`]
    );
    studentId = studentResult.rows[0].id;
  }, 20000);

  afterAll(async () => {
    await pool.query(
      `DELETE FROM attendance WHERE student_id = $1 AND class_id = $2 AND date = $3`,
      [studentId, CLASS_ID, QUEUED_DATE]
    );
    await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [studentUserId]);
    await offlineDb.delete();
    await pool.end();
  }, 20000);

  it(
    'queues an offline attendance entry in Dexie, syncs it on reconnect, and persists it to the database',
    async () => {
      // 1. Simulate offline entry: attendance is queued in the local Dexie DB while offline
      await offlineDb.offline_attendance_queue.add({
        school_id: SCHOOL_ID,
        class_id: CLASS_ID,
        date: QUEUED_DATE,
        entries: [{ student_id: studentId, status: 'present' }],
        queued_at: new Date().toISOString(),
      });

      expect(await offlineDb.offline_attendance_queue.count()).toBe(1);

      // 2. Simulate reconnect: drain the queue, posting each entry to the API
      //    (mirrors apps/web/lib/offlineSync.ts processOfflineQueues)
      for (const item of await offlineDb.offline_attendance_queue.toArray()) {
        const res = await request(app)
          .post(`/api/schools/${item.school_id}/attendance/mark`)
          .set('Authorization', `Bearer ${teacherToken}`)
          .send({ class_id: item.class_id, date: item.date, entries: item.entries });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);

        await offlineDb.offline_attendance_queue.delete(item.id!);
      }

      // 3. Queue is now empty
      expect(await offlineDb.offline_attendance_queue.count()).toBe(0);

      // 4. The record appears in the database
      const dbResult = await pool.query(
        `SELECT status FROM attendance WHERE student_id = $1 AND class_id = $2 AND date = $3`,
        [studentId, CLASS_ID, QUEUED_DATE]
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].status).toBe('present');
    },
    20000
  );
});
