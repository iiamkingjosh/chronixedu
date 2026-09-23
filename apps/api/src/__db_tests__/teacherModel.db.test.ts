/**
 * Primary vs secondary teaching model.
 *
 * `users.teacher_mode` is 'class' (primary: one teacher, every subject in their
 * class) or 'subject' (secondary). Both still require an explicit teacher_assignments
 * row per (class, subject, term), so a primary class teacher needed a dozen separate
 * requests per class — repeated every term, because assignments are term-scoped and
 * nothing carried them forward. These cover the bulk-assign and copy-forward paths
 * that fix that, plus per-level grading overrides for a school running both sections.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { getStudentsAtRisk } from '../services/resultEngine';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

const bulkAssign = (body: Record<string, unknown>) =>
  request(app).post(`${base}/teacher-assignments/bulk`)
    .set('Authorization', tokens.principalA()).send(body);

beforeEach(seed);
afterAll(() => pool.end());

describe('bulk assignment', () => {
  it('assigns one teacher to every subject in a class in a single call', async () => {
    // Seed assigns math->Math and eng->English on jss2a; give the maths teacher the
    // whole of jss3b, the primary-school "class teacher" case.
    const r = await bulkAssign({ teacher_id: I.mathTeacher, all_subjects_for_class_ids: [I.jss3b] });
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(2); // Mathematics + English exist in school A

    const rows = await pool.query(
      `SELECT subject_id FROM teacher_assignments WHERE teacher_id = $1 AND class_id = $2 AND term_id = $3`,
      [I.mathTeacher, I.jss3b, I.termA]
    );
    expect(rows.rows.map(r2 => r2.subject_id).sort()).toEqual([I.math, I.english].sort());
  });

  it('is idempotent — re-sending the same set creates nothing new', async () => {
    await bulkAssign({ teacher_id: I.mathTeacher, all_subjects_for_class_ids: [I.jss3b] });
    const again = await bulkAssign({ teacher_id: I.mathTeacher, all_subjects_for_class_ids: [I.jss3b] });
    expect(again.status).toBe(201);
    expect(again.body.data.created).toBe(0);
    expect(again.body.data.skipped).toBe(2);
  });

  it('accepts explicit pairs', async () => {
    const r = await bulkAssign({
      teacher_id: I.engTeacher,
      pairs: [{ class_id: I.jss3b, subject_id: I.math }],
    });
    expect(r.status).toBe(201);
    expect(r.body.data.created).toBe(1);
  });

  it('rejects a class from another school', async () => {
    const r = await bulkAssign({ teacher_id: I.mathTeacher, all_subjects_for_class_ids: [I.jss2a, I.termB] });
    expect(r.status).toBe(404);
  });

  it('refuses a teacher', async () => {
    const r = await request(app).post(`${base}/teacher-assignments/bulk`)
      .set('Authorization', tokens.math())
      .send({ teacher_id: I.mathTeacher, all_subjects_for_class_ids: [I.jss3b] });
    expect(r.status).toBe(403);
  });
});

describe('carrying assignments into a new term', () => {
  async function secondTerm(): Promise<string> {
    const r = await request(app).post(`${base}/sessions/${I.sessionA}/terms`)
      .set('Authorization', tokens.principalA())
      .send({ name: 'Second Term', start_date: '2027-01-10', end_date: '2027-04-02' });
    return r.body.data.id;
  }

  it('copies a whole term of assignments forward', async () => {
    const toTerm = await secondTerm();

    const before = await pool.query(`SELECT count(*)::int AS n FROM teacher_assignments WHERE term_id = $1`, [toTerm]);
    expect(before.rows[0].n).toBe(0);

    const r = await request(app).post(`${base}/teacher-assignments/copy-from-term`)
      .set('Authorization', tokens.principalA())
      .send({ from_term_id: I.termA, to_term_id: toTerm });
    expect(r.status).toBe(200);
    expect(r.body.data.copied).toBe(2);

    const after = await pool.query(
      `SELECT teacher_id, class_id, subject_id FROM teacher_assignments WHERE term_id = $1 ORDER BY subject_id`,
      [toTerm]
    );
    expect(after.rows).toHaveLength(2);
  });

  it('does not duplicate when run twice', async () => {
    const toTerm = await secondTerm();
    await request(app).post(`${base}/teacher-assignments/copy-from-term`)
      .set('Authorization', tokens.principalA()).send({ from_term_id: I.termA, to_term_id: toTerm });
    const second = await request(app).post(`${base}/teacher-assignments/copy-from-term`)
      .set('Authorization', tokens.principalA()).send({ from_term_id: I.termA, to_term_id: toTerm });

    expect(second.body.data.copied).toBe(0);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM teacher_assignments WHERE term_id = $1`, [toTerm]);
    expect(rows.rows[0].n).toBe(2);
  });

  it('refuses a term belonging to another school', async () => {
    const r = await request(app).post(`${base}/teacher-assignments/copy-from-term`)
      .set('Authorization', tokens.principalA())
      .send({ from_term_id: I.termA, to_term_id: I.termB });
    expect(r.status).toBe(404);
  });

  it('refuses copying a term onto itself', async () => {
    const r = await request(app).post(`${base}/teacher-assignments/copy-from-term`)
      .set('Authorization', tokens.principalA())
      .send({ from_term_id: I.termA, to_term_id: I.termA });
    expect(r.status).toBe(400);
  });
});

describe('per-level grading overrides', () => {
  /** The shared seed creates no school_settings row, so write the academic config
   *  the test needs. jss2a and jss3b are both level "Junior". */
  async function setAcademicConfig(config: Record<string, unknown>) {
    await pool.query(
      `INSERT INTO school_settings (school_id, academic_config)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (school_id) DO UPDATE SET academic_config = EXCLUDED.academic_config`,
      [I.schoolA, JSON.stringify(config)]
    );
  }

  /** Scores both students to a 65% overall average (CA1 20/30 + Exam 45/70). */
  async function enterMidRangeScores() {
    for (const [tok, subject] of [[tokens.math(), I.math], [tokens.english(), I.english]] as const) {
      await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok).send({
        subject_id: subject, class_id: I.jss2a, term_id: I.termA,
        entries: [I.s1, I.s2].flatMap(student_id => [
          { student_id, component_id: I.ca1, score: 20 },
          { student_id, component_id: I.exam, score: 45 },
        ]),
      });
    }
  }

  // These call the service directly rather than the dashboard route: that route wraps
  // the result in a 5-minute in-process NodeCache, which would serve one test's answer
  // to the next. The per-level resolution being tested lives in the service anyway.

  it('applies a level override to the pass mark used for at-risk students', async () => {
    await setAcademicConfig({
      promotion_cutoff: 40,
      level_overrides: { Junior: { promotion_cutoff: 90 } },
    });
    await enterMidRangeScores();

    const atRisk = await getStudentsAtRisk(I.termA, I.schoolA);

    // 65% overall: above the school-wide 40 but below the Junior override of 90.
    expect(atRisk.length).toBe(2);
    expect(atRisk[0].promotion_cutoff).toBe(90);
    expect(atRisk[0].deficit).toBe(25);
  });

  it('falls back to the school-wide cut-off when the level has no override', async () => {
    await setAcademicConfig({
      promotion_cutoff: 40,
      level_overrides: { Senior: { promotion_cutoff: 90 } },
    });
    await enterMidRangeScores();

    // "Junior" has no override, so the school-wide 40 applies and 65% is not at risk.
    expect(await getStudentsAtRisk(I.termA, I.schoolA)).toEqual([]);
  });

  it('uses the school-wide cut-off when no overrides are configured at all', async () => {
    await setAcademicConfig({ promotion_cutoff: 70 });
    await enterMidRangeScores();

    const atRisk = await getStudentsAtRisk(I.termA, I.schoolA);
    expect(atRisk.length).toBe(2);
    expect(atRisk[0].promotion_cutoff).toBe(70);
  });
});
