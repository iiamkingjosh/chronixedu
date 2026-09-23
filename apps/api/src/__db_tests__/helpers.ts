import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/client';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { errorHandler } from '../middleware/errorHandler';
import scoresRoutes from '../routes/scores';
import resultsRoutes from '../routes/results';
import studentsRoutes from '../routes/students';
import feesRoutes from '../routes/fees';
import dashboardRoutes from '../routes/dashboard';
import teacherDashboardRoutes from '../routes/teacherDashboard';
import parentRoutes from '../routes/parent';
import studentRoutes from '../routes/student';
import usersRoutes from '../routes/users';
import sessionsRoutes from '../routes/sessions';
import rosterRoutes from '../routes/roster';

// Fixed RFC-4122 v4 ids so zod's uuid() accepts them.
const id = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  schoolA: id('a0', 1),
  schoolB: id('b0', 1),
  sessionA: id('10', 1),
  termA: id('20', 1),
  sessionB: id('10', 2),
  termB: id('20', 2),
  mathTeacher: id('30', 1),
  engTeacher: id('30', 2),
  principalA: id('30', 3),
  principalB: id('30', 4),
  jss2a: id('40', 1),
  jss3b: id('40', 2),
  math: id('50', 1),
  english: id('50', 2),
  configA: id('70', 1),
  ca1: id('80', 1),
  exam: id('80', 2),
  s1: id('60', 1),
  s2: id('60', 2),
  s3OtherClass: id('60', 3),
  sOtherSchool: id('60', 9),
  // Parent of s1, and s1's own login — used by the publish-gate tests (AUDIT R10-H1).
  parentA: id('30', 5),
  s1User: id('39', 1),
};

export function token(userId: string, role: string, schoolId: string): string {
  return 'Bearer ' + jwt.sign(
    { user_id: userId, school_id: schoolId, role, email: `${userId}@test` },
    process.env.JWT_SECRET!
  );
}

export const tokens = {
  math: () => token(IDS.mathTeacher, 'teacher', IDS.schoolA),
  english: () => token(IDS.engTeacher, 'teacher', IDS.schoolA),
  principalA: () => token(IDS.principalA, 'principal', IDS.schoolA),
  principalB: () => token(IDS.principalB, 'principal', IDS.schoolB),
  parentA: () => token(IDS.parentA, 'parent', IDS.schoolA),
  studentS1: () => token(IDS.s1User, 'student', IDS.schoolA),
};

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool);
  for (const r of [scoresRoutes, resultsRoutes, studentsRoutes, feesRoutes, dashboardRoutes, teacherDashboardRoutes, parentRoutes, studentRoutes, usersRoutes, sessionsRoutes, rosterRoutes]) {
    app.use('/api/schools', r);
  }
  app.use(errorHandler);
  return app;
}

/** Wipes all tenant data and seeds two schools. School A: JSS 2A (s1, s2) taught Math + English;
 *  JSS 3B (s3). School-wide default config with CA1 (max 30) and Exam (max 70) shared by all subjects. */
export async function seed(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  await pool.query(`TRUNCATE ${rows.map(r => `"${r.tablename}"`).join(', ')} CASCADE`);

  const q = (sql: string, p: unknown[]) => pool.query(sql, p);
  const I = IDS;
  await q(`INSERT INTO schools (id, name, slug, is_active) VALUES ($1,'School A','school-a',true),($2,'School B','school-b',true)`, [I.schoolA, I.schoolB]);
  await q(`INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
           VALUES ($1,$2,'2026/2027','2026-09-01','2027-07-31',true),($3,$4,'2026/2027','2026-09-01','2027-07-31',true)`,
    [I.sessionA, I.schoolA, I.sessionB, I.schoolB]);
  await q(`INSERT INTO terms (id, session_id, school_id, name, start_date, end_date, is_current)
           VALUES ($1,$2,$3,'First Term','2026-09-01','2026-12-18',true),($4,$5,$6,'First Term','2026-09-01','2026-12-18',true)`,
    [I.termA, I.sessionA, I.schoolA, I.termB, I.sessionB, I.schoolB]);

  const user = (uid: string, school: string, role: string, first: string) =>
    q(`INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ($1,$2,$3,'x',$4,$5,'Test',true,'subject',false)`, [uid, school, `${uid}@test`, role, first]);
  await user(I.mathTeacher, I.schoolA, 'teacher', 'Math');
  await user(I.engTeacher, I.schoolA, 'teacher', 'Eng');
  await user(I.principalA, I.schoolA, 'principal', 'PrinA');
  await user(I.principalB, I.schoolB, 'principal', 'PrinB');

  await q(`INSERT INTO classes (id, school_id, name, level) VALUES ($1,$2,'JSS 2A','Junior'),($3,$2,'JSS 3B','Junior')`, [I.jss2a, I.schoolA, I.jss3b]);
  await q(`INSERT INTO subjects (id, school_id, name, code) VALUES ($1,$2,'Mathematics','MTH'),($3,$2,'English','ENG')`, [I.math, I.schoolA, I.english]);

  const student = async (sid: string, school: string, n: number) => {
    const uid = id('39', n);
    await user(uid, school, 'student', `Student${n}`);
    await q(`INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1,$2,$3,$4)`, [sid, school, uid, `ADM-${n}`]);
  };
  await student(I.s1, I.schoolA, 1);
  await student(I.s2, I.schoolA, 2);
  await student(I.s3OtherClass, I.schoolA, 3);
  await student(I.sOtherSchool, I.schoolB, 9);

  await q(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1,$3,$4),($2,$3,$4),($5,$6,$4)`,
    [I.s1, I.s2, I.jss2a, I.sessionA, I.s3OtherClass, I.jss3b]);

  // Parent of s1 only — lets the publish-gate tests exercise a real linked parent.
  await user(I.parentA, I.schoolA, 'parent', 'ParentA');
  await q(`INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
           VALUES ($1,$2,'mother',true)`, [I.parentA, I.s1]);
  await q(`INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1,$3,$4,$6,$7),($2,$3,$5,$6,$7)`,
    [I.mathTeacher, I.engTeacher, I.jss2a, I.math, I.english, I.termA, I.schoolA]);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO assessment_configs (id, school_id, term_id, is_default) VALUES ($1,$2,$3,true)`, [I.configA, I.schoolA, I.termA]);
    await c.query(`INSERT INTO assessment_components (id, config_id, name, max_score, weight_percent, display_order)
                   VALUES ($1,$3,'CA1',30,30,1),($2,$3,'Exam',70,70,2)`, [I.ca1, I.exam, I.configA]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export { pool };
