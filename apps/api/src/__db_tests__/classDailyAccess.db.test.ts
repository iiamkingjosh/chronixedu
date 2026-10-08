/**
 * A teacher sees only the students of classes they teach or form-teach (Batch 9, task 7; spec decision 5,
 * Moses, 8 Oct 2026).
 *
 * - A student's attendance history and behaviour history: a teacher read any student's in the school. Now only a
 *   student in a class they teach this session (an assignment in one of its terms) or form-teach.
 * - The attendance summary by class and the open attendance alerts were readable by every teacher, though only the
 *   principal's attendance page uses them, and the alerts name students of every class. They are the principal's
 *   now (school.overview), as decision 4 did for the other reads only the principal's screens use.
 */
import request from 'supertest';
import { seed, tokens, IDS as I, pool } from './helpers';
import express from 'express';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import attendanceRoutes from '../routes/attendance';
import behaviourRoutes from '../routes/behaviour';

const daily = express();
daily.use(express.json());
daily.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, attendanceRoutes, behaviourRoutes);
daily.use(errorHandler);

const base = `/api/schools/${I.schoolA}`;
const attendanceOf = (studentId: string, auth: string) =>
  request(daily).get(`${base}/attendance/student/${studentId}`).set('Authorization', auth).query({ term_id: I.termA });
const behaviourOf = (studentId: string, auth: string) =>
  request(daily).get(`${base}/behaviour/students/${studentId}`).set('Authorization', auth);

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
});
afterAll(() => pool.end());

describe("a student's attendance and behaviour", () => {
  it('are read by a teacher of their class, and not by a teacher of another', async () => {
    // The maths teacher teaches JSS 2A (s1) and not SSS 1B (s3).
    expect((await attendanceOf(I.s1, tokens.math())).status).toBe(200);
    expect((await behaviourOf(I.s1, tokens.math())).status).toBe(200);
    for (const res of [await attendanceOf(I.s3OtherClass, tokens.math()), await behaviourOf(I.s3OtherClass, tokens.math())]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it("are read by the class's form teacher, who need not teach a subject in it", async () => {
    await pool.query(`UPDATE classes SET form_teacher_id = $1 WHERE id = $2`, [I.mathTeacher, I.jss3b]);
    expect((await attendanceOf(I.s3OtherClass, tokens.math())).status).toBe(200);
    expect((await behaviourOf(I.s3OtherClass, tokens.math())).status).toBe(200);
  });

  it('are read by the principal for any student, and by a parent for their own child only', async () => {
    expect((await attendanceOf(I.s3OtherClass, tokens.principalA())).status).toBe(200);
    expect((await behaviourOf(I.s3OtherClass, tokens.principalA())).status).toBe(200);
    expect((await attendanceOf(I.s1, tokens.parentA())).status).toBe(200);
    expect((await attendanceOf(I.s2, tokens.parentA())).status).toBe(403);
  });
});

describe('the attendance summary by class and the open alerts', () => {
  it("are the principal's", async () => {
    for (const path of [`${base}/attendance/class-summary?term_id=${I.termA}`, `${base}/attendance/alerts`]) {
      expect((await request(daily).get(path).set('Authorization', tokens.principalA())).status).toBe(200);
      expect((await request(daily).get(path).set('Authorization', tokens.math())).status).toBe(403);
    }
  });
});
