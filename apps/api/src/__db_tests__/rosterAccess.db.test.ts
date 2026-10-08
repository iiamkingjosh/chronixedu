/**
 * Who manages the roster (Batch 9, task 4; Moses, 8 Oct 2026).
 *
 * - The registrar manages classes and subjects (spec decision 2).
 * - Not the form teacher: that field grants rights (the class's attendance and comments), so setting it is a
 *   permissions action, and granting rights is the principal's. A registrar's edit that leaves the field out keeps
 *   the principal's choice.
 * - Who teaches what is read by the principal, and by a teacher for their own (decision 4); it was open to every
 *   member of the school.
 * - The assessment structure is read by the principal only (decision 4); no other screen reads it.
 */
import express from 'express';
import request from 'supertest';
import { buildApp, seed, token, tokens, IDS as I, pool } from './helpers';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import assessmentConfigRoutes from '../routes/assessmentConfig';

const app = buildApp();
const ac = express();
ac.use(express.json());
ac.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, assessmentConfigRoutes);
ac.use(errorHandler);

const base = `/api/schools/${I.schoolA}`;
const REGISTRAR = '30000000-0000-4000-8000-000000000081';
const registrar = () => token(REGISTRAR, 'registrar', I.schoolA);
const formTeacherOf = async (classId: string) =>
  (await pool.query<{ form_teacher_id: string | null }>(`SELECT form_teacher_id FROM classes WHERE id = $1`, [classId])).rows[0].form_teacher_id;

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'registrar@roster.test', 'x', 'registrar', 'Reg', 'Istrar', true, 'subject', false)`, [REGISTRAR, I.schoolA]);
});
afterAll(() => pool.end());

describe('the registrar manages classes and subjects', () => {
  it('adds, renames and removes a class, and adds and renames a subject', async () => {
    const made = await request(app).post(`${base}/classes`).set('Authorization', registrar()).send({ name: 'JSS 1A', level: 'Junior' });
    expect(made.status).toBe(201);
    const renamed = await request(app).patch(`${base}/classes/${made.body.data.id}`).set('Authorization', registrar()).send({ name: 'JSS 1 Gold', level: 'Junior' });
    expect(renamed.status).toBe(200);
    expect((await request(app).delete(`${base}/classes/${made.body.data.id}`).set('Authorization', registrar())).status).toBe(200);

    const subject = await request(app).post(`${base}/subjects`).set('Authorization', registrar()).send({ name: 'Music', code: 'MUS' });
    expect(subject.status).toBe(201);
    expect((await request(app).patch(`${base}/subjects/${subject.body.data.id}`).set('Authorization', registrar()).send({ name: 'Music Theory', code: 'MUS' })).status).toBe(200);
  });

  it('but never sets or changes a form teacher; an edit that leaves it out keeps the principal\'s choice', async () => {
    // The principal sets one (the state the registrar must not change).
    expect((await request(app).patch(`${base}/classes/${I.jss2a}`).set('Authorization', tokens.principalA())
      .send({ name: 'JSS 2A', level: 'Junior', form_teacher_id: I.mathTeacher })).status).toBe(200);
    expect(await formTeacherOf(I.jss2a)).toBe(I.mathTeacher);

    const rename = await request(app).patch(`${base}/classes/${I.jss2a}`).set('Authorization', registrar()).send({ name: 'JSS 2 Alpha', level: 'Junior' });
    expect(rename.status).toBe(200);
    expect(await formTeacherOf(I.jss2a)).toBe(I.mathTeacher);

    const change = await request(app).patch(`${base}/classes/${I.jss2a}`).set('Authorization', registrar())
      .send({ name: 'JSS 2 Alpha', level: 'Junior', form_teacher_id: I.engTeacher });
    expect(change.status).toBe(403);
    expect(change.body.error.code).toBe('FORM_TEACHER_PRINCIPAL_ONLY');
    const clear = await request(app).patch(`${base}/classes/${I.jss2a}`).set('Authorization', registrar())
      .send({ name: 'JSS 2 Alpha', level: 'Junior', form_teacher_id: null });
    expect(clear.status).toBe(403);
    expect(await formTeacherOf(I.jss2a)).toBe(I.mathTeacher);

    const withTeacher = await request(app).post(`${base}/classes`).set('Authorization', registrar())
      .send({ name: 'JSS 1B', level: 'Junior', form_teacher_id: I.engTeacher });
    expect(withTeacher.status).toBe(403);
    expect(withTeacher.body.error.code).toBe('FORM_TEACHER_PRINCIPAL_ONLY');
    expect((await pool.query(`SELECT 1 FROM classes WHERE name = 'JSS 1B'`)).rowCount).toBe(0);
  });

  it('while teacher assignments stay the principal\'s', async () => {
    const assign = (auth: string) => request(app).post(`${base}/teacher-assignments`).set('Authorization', auth)
      .send({ teacher_id: I.engTeacher, class_id: I.jss3b, subject_id: I.english });
    expect((await assign(registrar())).status).toBe(403);
    expect((await assign(tokens.principalA())).status).toBe(201);
  });
});

describe('who teaches what is read by the principal, and by a teacher for their own', () => {
  const read = (teacherId: string, auth: string) =>
    request(app).get(`${base}/teachers/${teacherId}/assignments`).set('Authorization', auth);

  it('a teacher reads their own and not a colleague\'s; the principal reads any; nobody else reads it', async () => {
    const own = await read(I.mathTeacher, tokens.math());
    expect(own.status).toBe(200);
    expect(own.body.data.assignments.length).toBeGreaterThan(0);
    expect((await read(I.engTeacher, tokens.math())).status).toBe(403);
    expect((await read(I.engTeacher, tokens.principalA())).status).toBe(200);
    expect((await read(I.mathTeacher, registrar())).status).toBe(403);
    expect((await read(I.mathTeacher, tokens.parentA())).status).toBe(403);
  });
});

describe('the assessment structure is read by the principal only', () => {
  it('the principal reads it, and a teacher does not', async () => {
    const principal = await request(ac).get(`${base}/assessment-config`).set('Authorization', tokens.principalA());
    expect(principal.status).toBe(200);
    expect(principal.body.data.length).toBeGreaterThan(0);
    expect((await request(ac).get(`${base}/assessment-config`).set('Authorization', tokens.math())).status).toBe(403);
    const resolve = await request(ac).get(`${base}/assessment-config/resolve`).set('Authorization', tokens.math())
      .query({ class_id: I.jss2a, subject_id: I.math, term_id: I.termA });
    expect(resolve.status).toBe(403);
  });
});
