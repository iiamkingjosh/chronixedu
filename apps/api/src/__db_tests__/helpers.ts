import express from 'express';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import pool from '../db/client';
import { SYSTEM_ACTOR } from '../config/systemActor';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import scoresRoutes from '../routes/scores';
import resultsRoutes from '../routes/results';
import studentsRoutes from '../routes/students';
import feesRoutes from '../routes/fees';
import platformBillingRoutes from '../routes/platformBilling';
import dashboardRoutes from '../routes/dashboard';
import teacherDashboardRoutes from '../routes/teacherDashboard';
import parentRoutes from '../routes/parent';
import studentRoutes from '../routes/student';
import usersRoutes from '../routes/users';
import sessionsRoutes from '../routes/sessions';
import rosterRoutes from '../routes/roster';
import noticesRoutes from '../routes/notices';
// Appended last in buildApp: its GET '/:schoolId' is the broadest route here, so it
// must only ever see requests no more specific router matched.
import schoolsRoutes from '../routes/schools';

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
  app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription);
  for (const r of [scoresRoutes, resultsRoutes, studentsRoutes, feesRoutes, platformBillingRoutes, dashboardRoutes, teacherDashboardRoutes, parentRoutes, studentRoutes, usersRoutes, sessionsRoutes, rosterRoutes, noticesRoutes, schoolsRoutes]) {
    app.use('/api/schools', r);
  }
  app.use(errorHandler);
  return app;
}

/**
 * Wipes all tenant data and seeds two schools. School A: JSS 2A (s1, s2, level Junior)
 * taught Math + English; SSS 1B (s3, level Senior — still `IDS.jss3b`, kept for the
 * dozens of references). School-wide default config with CA1 (max 50, weight 30) and
 * Exam (max 100, weight 70) shared by all subjects.
 *
 * ## No accidental identities
 *
 * A fixture value that makes an operation equivalent to doing nothing makes every test of
 * that operation unfalsifiable, however well written. Three were found and removed on
 * 28 Sep 2026; keep it that way when editing this file:
 *
 *   - **Component max ≠ weight.** It was 30/30 and 70/70, so `score / max × weight` was
 *     the identity and every test that entered scores would have passed with the
 *     weighting deleted. Now ×0.6 for CA1 and ×0.7 for Exam, so a raw-score bug, a
 *     max/weight swap and a CA/Exam mix-up each change the answer.
 *   - **Classes differ in level.** Both were "Junior", so per-class level resolution —
 *     `level_overrides`, class-level assessment configs — could not be told apart from
 *     "use any class's level". Now Junior and Senior.
 *   - **The two schools' terms differ in dates.** They were identical, so a date lookup
 *     missing its `school_id` filter returned the wrong tenant's term only sometimes.
 *     Different dates make that bug deterministic.
 *
 * ## Why this is one transaction on one connection
 *
 * It used to be ~20 separate `pool.query` calls, each its own implicit transaction, each
 * possibly on a different pooled connection. That is what turned a slow seed into the
 * flake that took two days to name.
 *
 * Jest's `testTimeout` stops *waiting*; it does not stop the *work*. Node does not cancel
 * an in-flight query, so when `beforeEach(seed)` exceeded the timeout, Jest moved on and
 * the remaining INSERTs kept running and committing one by one — landing AFTER the next
 * test's TRUNCATE. The next test then died with `duplicate key ... "schools_pkey"`, in a
 * different suite, with no timeout anywhere in sight. Raising the Jest timeout lowers how
 * often that happens and leaves the mechanism completely intact: a bigger fixture or a
 * slower box reproduces it exactly, and the larger number reads like a bound someone had
 * already proven adequate.
 *
 * So enforcement moved to the layer that can actually stop the work:
 *
 *   - **One transaction.** Nothing is visible until COMMIT, and an abandoned seed cannot
 *     interleave with the next test: that test's TRUNCATE takes ACCESS EXCLUSIVE and
 *     therefore waits for this transaction to finish rather than racing it. Either the
 *     whole fixture lands and is then truncated, or none of it does.
 *   - **`statement_timeout`.** Postgres aborts a statement that overruns and rolls the
 *     transaction back. This is a real stop, not a stopped wait.
 *   - **`idle_in_transaction_session_timeout`.** Covers the other shape: a transaction
 *     left open between statements because the caller went away.
 *
 * Both are set below Jest's `testTimeout`, so the database wins the race and the failure
 * surfaces as a slow seed in the test that owns it — every time, in the same place. Jest's
 * timeout goes back to being the outer backstop it should always have been.
 *
 * One honest limit: `statement_timeout` bounds each statement, not the transaction. A seed
 * made slow by twenty moderately slow statements can still exceed Jest's timeout without
 * tripping it. That no longer causes the cascade — the transaction guarantees that — but
 * it would still fail the run, which is the correct outcome for a seed that has genuinely
 * become too slow.
 */
export async function seed(): Promise<void> {
  // The OWNER, always — not the app pool. seed() TRUNCATEs every table, which the C-4a app
  // role correctly cannot do, and in role mode (jest.db.roles.config.js) the app pool IS
  // that role. A short-lived client per seed rather than a second pool: nothing is left
  // open for Jest to wait on, and in ordinary runs it is the same database and user the
  // pool would have used.
  // connectionTimeoutMillis matches the pool this replaced. Without it a connect that
  // stalls on a starved host has no deadline of its own, so it surfaced only as Jest's
  // 30s "hook timeout" — naming the hook, not the stalled connect — and the seed's
  // statement_timeout cannot help because no statement has started yet.
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    await c.query('BEGIN');
    // Below jest.db.config.js's testTimeout (30s) on purpose: whichever fires first
    // decides what the failure looks like, and the database's version is the one that
    // actually rolls the work back.
    await c.query(`SET LOCAL statement_timeout = '20s'`);
    await c.query(`SET LOCAL idle_in_transaction_session_timeout = '20s'`);

    const { rows } = await c.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
    );
    await c.query(`TRUNCATE ${rows.map(r => `"${r.tablename}"`).join(', ')} CASCADE`);

    const q = (sql: string, p: unknown[]) => c.query(sql, p);
    const I = IDS;
    // Migration 053's system account, which the TRUNCATE above just removed. The trial gate refuses
    // to run without it. Same values as the migration (systemActor.test.ts checks the migration).
    await q(`INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password, two_factor_required)
             VALUES ($1, NULL, $2, '', 'super_admin', $3, $4, false, false, false)`,
      [SYSTEM_ACTOR.id, SYSTEM_ACTOR.email, SYSTEM_ACTOR.firstName, SYSTEM_ACTOR.lastName]);
    // Migration 039: a school is born dormant and is activated once it has an active
    // principal. The fixture follows the same path production does — inserting an active
    // school here would be testing a system that is not shipped.
    await q(`INSERT INTO schools (id, name, slug, is_active, is_demo) VALUES ($1,'School A','school-a',FALSE,FALSE),($2,'School B','school-b',FALSE,FALSE)`, [I.schoolA, I.schoolB]);
    await q(`INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
             VALUES ($1,$2,'2026/2027','2026-09-01','2027-07-31',true),($3,$4,'2026/2027','2026-09-01','2027-07-31',true)`,
      [I.sessionA, I.schoolA, I.sessionB, I.schoolB]);
    await q(`INSERT INTO terms (id, session_id, school_id, name, start_date, end_date, is_current)
             VALUES ($1,$2,$3,'First Term','2026-09-01','2026-12-18',true),($4,$5,$6,'First Term','2026-09-08','2026-12-11',true)`,
      [I.termA, I.sessionA, I.schoolA, I.termB, I.sessionB, I.schoolB]);

    const user = (uid: string, school: string, role: string, first: string) =>
      q(`INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
         VALUES ($1,$2,$3,'x',$4,$5,'Test',true,'subject',false)`, [uid, school, `${uid}@test`, role, first]);
    await user(I.mathTeacher, I.schoolA, 'teacher', 'Math');
    await user(I.engTeacher, I.schoolA, 'teacher', 'Eng');
    await user(I.principalA, I.schoolA, 'principal', 'PrinA');
    await user(I.principalB, I.schoolB, 'principal', 'PrinB');

    // Activated only now, because migration 039 requires an ACTIVE principal on the
    // FALSE -> TRUE transition and users.school_id references schools, so the principal
    // cannot exist any earlier. This is the order the onboarding wizard uses.
    await q(`UPDATE schools SET is_active = TRUE WHERE id = ANY($1::uuid[])`, [[I.schoolA, I.schoolB]]);

    await q(`INSERT INTO classes (id, school_id, name, level) VALUES ($1,$2,'JSS 2A','Junior'),($3,$2,'SSS 1B','Senior')`, [I.jss2a, I.schoolA, I.jss3b]);
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

    // These two no longer need a transaction of their own — they are inside the seed's.
    // trg_assessment_components_total_check is DEFERRABLE INITIALLY DEFERRED (migration
    // 002), so it fires once at the COMMIT below, after both rows exist.
    await q(`INSERT INTO assessment_configs (id, school_id, term_id, is_default) VALUES ($1,$2,$3,true)`, [I.configA, I.schoolA, I.termA]);
    await q(`INSERT INTO assessment_components (id, config_id, name, max_score, weight_percent, display_order)
             VALUES ($1,$3,'CA1',50,30,1),($2,$3,'Exam',100,70,2)`, [I.ca1, I.exam, I.configA]);

    await c.query('COMMIT');
  } catch (e) {
    // A ROLLBACK on a connection the server already aborted (statement_timeout) throws
    // in its own right; swallowing that keeps the ORIGINAL error as the reported cause,
    // which is the one naming why the seed was too slow.
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

/**
 * A school's grading scale, set EXPLICITLY. The seed gives no school a scale on purpose —
 * nothing seeds one in production either (doctrine 8), and POST /results/publish refuses
 * with GRADING_SCALE_NOT_SET until one is set. A suite that publishes calls this in its own
 * setup, through the same upsert the settings page uses.
 */
export async function setGradingScale(schoolId: string): Promise<void> {
  const { updateAcademicConfig } = await import('../db/queries/schools');
  await updateAcademicConfig(schoolId, {
    grading_scale: [
      { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: 'Excellent' },
      { grade: 'B', min: 60, max: 69, label: 'Very Good', remark: 'Very good' },
      { grade: 'C', min: 50, max: 59, label: 'Good', remark: 'Good' },
      { grade: 'D', min: 40, max: 49, label: 'Pass', remark: 'Pass' },
      { grade: 'F', min: 0, max: 39, label: 'Fail', remark: 'Fail' },
    ],
  });
}

export { pool };
