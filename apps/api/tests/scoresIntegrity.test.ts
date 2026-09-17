import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import scoresRouter from '../src/routes/scores';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', scoresRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

// Regression coverage for a real bug found and fixed in this pass: a teacher
// legitimately assigned to (subject, class, term) could write a score against
// ANY student_id in the school (class_id was checked for the teacher's own
// assignment but never cross-checked against the submitted student's actual
// enrollment), and two subjects sharing an assessment component (a school-wide
// default grading scheme) silently overwrote each other's score because the
// scores table's uniqueness key didn't include subject_id.
describe('Score write integrity', () => {
  const suffix = randomUUID().slice(0, 8);
  let schoolId: string;
  let sessionId: string;
  let termId: string;
  let classAId: string;
  let classBId: string;
  let mathSubjectId: string;
  let biologySubjectId: string;
  let englishSubjectId: string;
  let mathTeacherId: string;
  let mathTeacherToken: string;
  let biologyTeacherToken: string;
  let studentAId: string;   // enrolled in classA
  let studentBId: string;   // enrolled in classB, NOT classA
  let defaultComponentId: string; // shared default config's sole component
  let englishOnlyComponentId: string; // belongs to a subject-specific config, not the default

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ('Scores Integrity Test', $1, true) RETURNING id`,
      [`scores-integrity-${suffix}`]
    );
    schoolId = schoolResult.rows[0].id;

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2026/2027', '2026-09-01', '2027-07-31', true) RETURNING id`,
      [schoolId]
    );
    sessionId = sessionResult.rows[0].id;

    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (session_id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, 'First Term', '2026-09-01', '2026-12-18', true) RETURNING id`,
      [sessionId, schoolId]
    );
    termId = termResult.rows[0].id;

    const classAResult = await pool.query<{ id: string }>(
      `INSERT INTO classes (school_id, name, level) VALUES ($1, 'JSS1A', 'JSS1') RETURNING id`,
      [schoolId]
    );
    classAId = classAResult.rows[0].id;

    const classBResult = await pool.query<{ id: string }>(
      `INSERT INTO classes (school_id, name, level) VALUES ($1, 'JSS1B', 'JSS1') RETURNING id`,
      [schoolId]
    );
    classBId = classBResult.rows[0].id;

    const mathResult = await pool.query<{ id: string }>(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Mathematics', 'MATH') RETURNING id`,
      [schoolId]
    );
    mathSubjectId = mathResult.rows[0].id;

    const biologyResult = await pool.query<{ id: string }>(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Biology', 'BIO') RETURNING id`,
      [schoolId]
    );
    biologySubjectId = biologyResult.rows[0].id;

    // English has its own subject-specific config (see below) — only used as
    // the source of a "wrong" component_id for the ownership-check test, no
    // English teacher account is needed.
    const englishResult = await pool.query<{ id: string }>(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'English', 'ENG') RETURNING id`,
      [schoolId]
    );
    englishSubjectId = englishResult.rows[0].id;

    const mathTeacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Math', 'Teacher', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `math-teacher-${suffix}@test.com`]
    );
    mathTeacherId = mathTeacherResult.rows[0].id;
    mathTeacherToken = makeToken(mathTeacherId, 'teacher', schoolId, mathTeacherResult.rows[0].email);

    const biologyTeacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Biology', 'Teacher', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `biology-teacher-${suffix}@test.com`]
    );
    const biologyTeacherId = biologyTeacherResult.rows[0].id;
    biologyTeacherToken = makeToken(biologyTeacherId, 'teacher', schoolId, biologyTeacherResult.rows[0].email);

    await pool.query(
      `INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1, $2, $3, $4, $5)`,
      [mathTeacherId, classAId, mathSubjectId, termId, schoolId]
    );
    await pool.query(
      `INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1, $2, $3, $4, $5)`,
      [biologyTeacherId, classAId, biologySubjectId, termId, schoolId]
    );

    const studentAUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
       VALUES ($1, $2, 'test-hash', 'student', 'Ada', 'Enrolled', FALSE) RETURNING id`,
      [schoolId, `student-a-${suffix}@test.com`]
    );
    const studentAUserId = studentAUserResult.rows[0].id;
    const studentAResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentAUserId, `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    studentAId = studentAResult.rows[0].id;
    await pool.query(
      `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
      [studentAId, classAId, sessionId]
    );

    const studentBUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
       VALUES ($1, $2, 'test-hash', 'student', 'Bola', 'OtherClass', FALSE) RETURNING id`,
      [schoolId, `student-b-${suffix}@test.com`]
    );
    const studentBUserId = studentBUserResult.rows[0].id;
    const studentBResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentBUserId, `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    studentBId = studentBResult.rows[0].id;
    await pool.query(
      `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
      [studentBId, classBId, sessionId]
    );

    // A school-wide default assessment config (subject_id NULL) — the common
    // real-world setup where every subject shares the same CA/Exam scheme,
    // and therefore the same component_id values.
    const defaultConfigResult = await pool.query<{ id: string }>(
      `INSERT INTO assessment_configs (school_id, term_id, subject_id, class_level, is_default)
       VALUES ($1, $2, NULL, NULL, TRUE) RETURNING id`,
      [schoolId, termId]
    );
    const defaultComponentResult = await pool.query<{ id: string }>(
      `INSERT INTO assessment_components (config_id, name, max_score, weight_percent, display_order)
       VALUES ($1, 'Exam', 100, 100, 1) RETURNING id`,
      [defaultConfigResult.rows[0].id]
    );
    defaultComponentId = defaultComponentResult.rows[0].id;

    // A subject-specific config for English, with its own distinct component —
    // used to prove a Math-assigned teacher can't write against it.
    const englishConfigResult = await pool.query<{ id: string }>(
      `INSERT INTO assessment_configs (school_id, term_id, subject_id, class_level, is_default)
       VALUES ($1, $2, $3, NULL, FALSE) RETURNING id`,
      [schoolId, termId, englishSubjectId]
    );
    const englishComponentResult = await pool.query<{ id: string }>(
      `INSERT INTO assessment_components (config_id, name, max_score, weight_percent, display_order)
       VALUES ($1, 'English Essay', 100, 100, 1) RETURNING id`,
      [englishConfigResult.rows[0].id]
    );
    englishOnlyComponentId = englishComponentResult.rows[0].id;
  }, 30000);

  afterAll(async () => {
    // Under the flaky network conditions this suite runs against, a single
    // stale pooled connection can leave pool.end() waiting indefinitely for
    // that one client's graceful close to complete. Race it against a timeout
    // so a bad connection can't fail this hook — the process exit that follows
    // force-closes any socket still open regardless.
    await Promise.race([
      pool.end(),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }, 15000);

  describe('POST /:schoolId/scores/entry', () => {
    it('rejects a score for a student not enrolled in the specified class, even for a teacher legitimately assigned to that class/subject', async () => {
      const res = await request(app)
        .post(`/api/schools/${schoolId}/scores/entry`)
        .set('Authorization', `Bearer ${mathTeacherToken}`)
        .send({
          student_id: studentBId, // enrolled in classB, not classA
          subject_id: mathSubjectId,
          class_id: classAId,     // the teacher's real, legitimate assignment
          term_id: termId,
          component_id: defaultComponentId,
          score: 70,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('STUDENT_NOT_ENROLLED');

      const written = await pool.query(
        `SELECT id FROM scores WHERE student_id = $1 AND subject_id = $2`,
        [studentBId, mathSubjectId]
      );
      expect(written.rows.length).toBe(0);
    }, 20000);

    it('rejects a component_id that is not part of the assessment config resolved for the submitted class/subject/term', async () => {
      // The Math teacher, legitimately assigned to classA/Math, tries to use
      // the component that only exists in English's subject-specific config.
      const res = await request(app)
        .post(`/api/schools/${schoolId}/scores/entry`)
        .set('Authorization', `Bearer ${mathTeacherToken}`)
        .send({
          student_id: studentAId,
          subject_id: mathSubjectId,
          class_id: classAId,
          term_id: termId,
          component_id: englishOnlyComponentId,
          score: 70,
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      const written = await pool.query(
        `SELECT id FROM scores WHERE student_id = $1 AND component_id = $2`,
        [studentAId, englishOnlyComponentId]
      );
      expect(written.rows.length).toBe(0);
    }, 20000);

    it('keeps two subjects that share the same default assessment component as separate rows, instead of overwriting each other', async () => {
      // Neither Math nor Biology has a subject-specific config, so both
      // legitimately resolve to the same school-wide default component —
      // the common real-world setup this bug corrupted.
      const mathRes = await request(app)
        .post(`/api/schools/${schoolId}/scores/entry`)
        .set('Authorization', `Bearer ${mathTeacherToken}`)
        .send({
          student_id: studentAId,
          subject_id: mathSubjectId,
          class_id: classAId,
          term_id: termId,
          component_id: defaultComponentId,
          score: 72,
        });
      expect(mathRes.status).toBe(201);

      const biologyRes = await request(app)
        .post(`/api/schools/${schoolId}/scores/entry`)
        .set('Authorization', `Bearer ${biologyTeacherToken}`)
        .send({
          student_id: studentAId,
          subject_id: biologySubjectId,
          class_id: classAId,
          term_id: termId,
          component_id: defaultComponentId, // same shared component as Math used
          score: 41,
        });
      expect(biologyRes.status).toBe(201);

      const rows = await pool.query<{ subject_id: string; score: string }>(
        `SELECT subject_id, score FROM scores
         WHERE student_id = $1 AND term_id = $2 AND component_id = $3
         ORDER BY subject_id`,
        [studentAId, termId, defaultComponentId]
      );
      expect(rows.rows.length).toBe(2);

      const mathRow = rows.rows.find(r => r.subject_id === mathSubjectId);
      const biologyRow = rows.rows.find(r => r.subject_id === biologySubjectId);
      expect(Number(mathRow?.score)).toBe(72);
      expect(Number(biologyRow?.score)).toBe(41);
    }, 20000);
  });

  describe('POST /:schoolId/scores/bulk-entry', () => {
    it('rejects a batch entry for a student not enrolled in the specified class', async () => {
      const res = await request(app)
        .post(`/api/schools/${schoolId}/scores/bulk-entry`)
        .set('Authorization', `Bearer ${mathTeacherToken}`)
        .send({
          subject_id: mathSubjectId,
          class_id: classAId,
          term_id: termId,
          entries: [{ student_id: studentBId, component_id: defaultComponentId, score: 60 }],
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BULK_VALIDATION_FAILED');
      expect(res.body.error.details[0].reason).toMatch(/not enrolled/i);

      const written = await pool.query(
        `SELECT id FROM scores WHERE student_id = $1 AND subject_id = $2`,
        [studentBId, mathSubjectId]
      );
      expect(written.rows.length).toBe(0);
    }, 20000);

    it('rejects a batch entry using a component_id from a different subject\'s config', async () => {
      const res = await request(app)
        .post(`/api/schools/${schoolId}/scores/bulk-entry`)
        .set('Authorization', `Bearer ${mathTeacherToken}`)
        .send({
          subject_id: mathSubjectId,
          class_id: classAId,
          term_id: termId,
          entries: [{ student_id: studentAId, component_id: englishOnlyComponentId, score: 60 }],
        });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BULK_VALIDATION_FAILED');
      expect(res.body.error.details[0].reason).toMatch(/not part of the assessment config/i);
    }, 20000);
  });
});
