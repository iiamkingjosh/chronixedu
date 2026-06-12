import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import 'fake-indexeddb/auto';
import Dexie, { Table } from 'dexie';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import attendanceRouter from '../src/routes/attendance';
import { errorHandler } from '../src/middleware/errorHandler';

// ── Fixed test data (seeded) ───────────────────────────────────────────────────
const SCHOOL_ID  = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID   = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const FATIMA_ID  = '483dc14c-b865-45eb-99f9-fde8b2dbf16e';
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
  const offlineDb = new ChronixOfflineTestDB();
  const teacherToken = makeToken('teacher', SCHOOL_ID, TEACHER_ID);

  afterAll(async () => {
    await pool.query(`DELETE FROM attendance WHERE student_id = $1 AND class_id = $2 AND date = $3`, [
      FATIMA_ID,
      CLASS_ID,
      QUEUED_DATE,
    ]);
    await offlineDb.delete();
    await pool.end();
  });

  it(
    'queues an offline attendance entry in Dexie, syncs it on reconnect, and persists it to the database',
    async () => {
      // 1. Simulate offline entry: attendance is queued in the local Dexie DB while offline
      await offlineDb.offline_attendance_queue.add({
        school_id: SCHOOL_ID,
        class_id: CLASS_ID,
        date: QUEUED_DATE,
        entries: [{ student_id: FATIMA_ID, status: 'present' }],
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
        [FATIMA_ID, CLASS_ID, QUEUED_DATE]
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].status).toBe('present');
    },
    20000
  );
});
