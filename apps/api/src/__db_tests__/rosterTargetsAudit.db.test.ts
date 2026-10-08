/**
 * Teaching assignments and timetable slots name this school's class, subject and term, and roster
 * changes are recorded (audit, 8 Oct 2026, S1 and S3; doctrines 3 and 10).
 *
 * An assignment checked its teacher against the school and took any class and subject id; a timetable
 * slot took any class, subject and term. Nothing about classes, subjects, assignments or slots was
 * audited, except bulk assignment and copying.
 */
import express from 'express';
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import timetableRoutes from '../routes/timetable';

const app = buildApp();
const tt = express();
tt.use(express.json());
tt.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, timetableRoutes);
tt.use(errorHandler);
const base = `/api/schools/${I.schoolA}`;

let classB: string;
let subjectB: string;
const audits = async (action: string) => (await pool.query(`SELECT new_value, old_value FROM audit_logs WHERE action_type = $1`, [action])).rows;

beforeEach(async () => {
  await seed();
  classB = (await pool.query<{ id: string }>(`INSERT INTO classes (school_id, name, level) VALUES ($1, 'B1', 'Junior') RETURNING id`, [I.schoolB])).rows[0].id;
  subjectB = (await pool.query<{ id: string }>(`INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Physics', 'PHY') RETURNING id`, [I.schoolB])).rows[0].id;
});
afterAll(() => pool.end());

describe('a teaching assignment', () => {
  const assign = (body: object) => request(app).post(`${base}/teacher-assignments`).set('Authorization', tokens.principalA()).send(body);

  it("names only this school's class and subject, and is recorded", async () => {
    expect((await assign({ teacher_id: I.mathTeacher, class_id: classB, subject_id: I.math })).status).toBe(404);
    expect((await assign({ teacher_id: I.mathTeacher, class_id: I.jss3b, subject_id: subjectB })).status).toBe(404);

    const ok = await assign({ teacher_id: I.mathTeacher, class_id: I.jss3b, subject_id: I.math });
    expect(ok.status).toBe(201);
    expect(await audits('TEACHER_ASSIGNED')).toEqual([expect.objectContaining({ new_value: expect.objectContaining({ teacher_id: I.mathTeacher, class_id: I.jss3b, subject_id: I.math }) })]);

    const del = await request(app).delete(`${base}/teacher-assignments/${ok.body.data.id}`).set('Authorization', tokens.principalA());
    expect(del.status).toBe(200);
    expect(await audits('TEACHER_UNASSIGNED')).toHaveLength(1);
  });
});

describe('a timetable slot', () => {
  const slot = (over: object) => request(tt).post(`${base}/timetable`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA, day_of_week: 1, period_number: 1, subject_id: I.math, teacher_id: I.mathTeacher, ...over });

  it("names only this school's class, subject and term, and is recorded", async () => {
    for (const over of [{ class_id: classB }, { subject_id: subjectB }, { term_id: I.termB }]) {
      expect({ over, status: (await slot(over)).status }).toEqual({ over, status: 404 });
    }
    expect((await pool.query(`SELECT 1 FROM timetable_slots`)).rowCount).toBe(0);

    const ok = await slot({});
    expect(ok.status).toBe(201);
    expect(await audits('TIMETABLE_SLOT_CREATED')).toHaveLength(1);
  });
});

describe('classes and subjects', () => {
  it('creating, editing and deleting are recorded, an edit with what it replaced', async () => {
    const made = await request(app).post(`${base}/classes`).set('Authorization', tokens.principalA()).send({ name: 'JSS 1A', level: 'Junior' });
    expect(made.status).toBe(201);
    await request(app).patch(`${base}/classes/${made.body.data.id}`).set('Authorization', tokens.principalA()).send({ name: 'JSS 1 Gold', level: 'Junior' });
    await request(app).delete(`${base}/classes/${made.body.data.id}`).set('Authorization', tokens.principalA());
    expect(await audits('CLASS_CREATED')).toHaveLength(1);
    const [edit] = await audits('CLASS_UPDATED');
    expect(edit.old_value).toMatchObject({ name: 'JSS 1A' });
    expect(edit.new_value).toMatchObject({ name: 'JSS 1 Gold' });
    expect(await audits('CLASS_DELETED')).toHaveLength(1);

    const subj = await request(app).post(`${base}/subjects`).set('Authorization', tokens.principalA()).send({ name: 'Music', code: 'MUS' });
    expect(subj.status).toBe(201);
    expect(await audits('SUBJECT_CREATED')).toHaveLength(1);
  });
});
