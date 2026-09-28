/**
 * The result engine's arithmetic and ranking, against the deterministic seed.
 *
 * Ported from `apps/api/tests/resultEngine.test.ts`, which had not executed an assertion
 * since 17 June 2026. It depended on a student called Fatima having Mathematics scores in
 * whatever database it was pointed at; the integration globalSetup — introduced in the
 * same commit that last touched that file — seeds Fatima but never her scores, so every
 * clean run took `if (skip) return;` and Jest reported three PASSES. The integration
 * count had been carrying three tests that tested nothing for three and a half months.
 *
 * Worse than unrun: two of the three would have thrown. They upserted with
 * `ON CONFLICT (student_id, term_id, component_id)`, and migration 028 (17 Sep) replaced
 * that constraint with one that includes subject_id (doctrine 4). Against the current
 * schema the clause raises "there is no unique or exclusion constraint matching the ON
 * CONFLICT specification" — measured, not inferred. The skip hid a broken test, not merely
 * an idle one.
 *
 * Everything here runs every time. No assertion is conditional on data being present,
 * and the tie case constructs its tie rather than hoping the fixture happens to have one.
 */
import { seed, IDS as I, pool } from './helpers';
import { computeStudentSubjectResult, computeClassResults } from '../services/resultEngine';

beforeEach(seed);
afterAll(async () => {
  await pool.end();
});

async function score(studentId: string, componentId: string, value: number, subjectId = I.math) {
  await pool.query(
    `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [I.schoolA, studentId, subjectId, I.termA, componentId, value]
  );
}

/** A Mathematics total, entered as CA1 + Exam. Seed config: CA1 max 50 / weight 30 (×0.6), Exam max 100 / weight 70 (×0.7). */
async function mathTotal(studentId: string, ca1: number, exam: number) {
  await score(studentId, I.ca1, ca1);
  await score(studentId, I.exam, exam);
}

/** One more student in JSS 2A for the current session — the seed has two, and a gap needs more. */
async function enrolExtraStudent(n: number): Promise<string> {
  const userId = `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const studentId = `e1000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, $3, 'x', 'student', $4, 'Test', true, 'subject', false)`,
    [userId, I.schoolA, `${userId}@test`, `Extra${n}`]
  );
  await pool.query(
    `INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1, $2, $3, $4)`,
    [studentId, I.schoolA, userId, `ADM-X${n}`]
  );
  await pool.query(
    `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
    [studentId, I.jss2a, I.sessionA]
  );
  return studentId;
}

describe('computeStudentSubjectResult — the weighted total', () => {
  it('scales each component by weight / max_score, not by the raw score', async () => {
    // This test first had to raise CA1's max locally, because the seed then had
    // max == weight (30/30, 70/70) and the weighting was an identity. The seed no longer
    // does (see helpers.ts), so every test that enters scores now exercises the formula —
    // this one just states it outright.
    await mathTotal(I.s1, 20, 60);

    const result = await computeStudentSubjectResult(I.s1, I.math, I.termA, I.schoolA);
    expect(result).not.toBeNull();

    const ca1 = result!.components.find(c => c.component_id === I.ca1);
    const exam = result!.components.find(c => c.component_id === I.exam);
    expect(ca1!.score).toBe(20);
    expect(ca1!.contribution).toBe(12); // 20 / 50 × 30
    expect(exam!.contribution).toBe(42); // 60 / 100 × 70
    // 54, not 80 — 80 is what summing raw scores would give.
    expect(result!.total_score).toBe(54);
  });

  it('counts an unscored component as zero rather than dropping it from the total', async () => {
    await score(I.s1, I.ca1, 25); // no Exam score
    const result = await computeStudentSubjectResult(I.s1, I.math, I.termA, I.schoolA);
    expect(result!.components.find(c => c.component_id === I.exam)!.contribution).toBe(0);
    expect(result!.total_score).toBe(15); // 25 / 50 × 30
  });
});

describe('computeClassResults — standard competition ranking', () => {
  it('orders distinct averages and numbers them 1, 2', async () => {
    await mathTotal(I.s1, 25, 100); // 15 + 70 = 85
    await mathTotal(I.s2, 10, 40);  // 6 + 28 = 34

    const { students } = await computeClassResults(I.jss2a, I.termA, I.schoolA);
    const s1 = students.find(s => s.student_id === I.s1)!;
    const s2 = students.find(s => s.student_id === I.s2)!;

    expect(s1.overall_average).toBe(85);
    expect(s2.overall_average).toBe(34);
    expect(s1.position).toBe(1);
    expect(s2.position).toBe(2);
    expect(students.findIndex(s => s.student_id === I.s1))
      .toBeLessThan(students.findIndex(s => s.student_id === I.s2));
  });

  it('gives [85, 85, 72, 65] the positions [1, 1, 3, 4] — the example in the engine’s own comment', async () => {
    // The tie is constructed, not hoped for. Four students, because the documented
    // example has four: two to tie, one to prove position 2 is skipped, and one to prove
    // numbering carries on from 3 rather than restarting.
    const x3 = await enrolExtraStudent(3);
    const x4 = await enrolExtraStudent(4);
    await mathTotal(I.s1, 25, 100); // 15 + 70 = 85
    await mathTotal(I.s2, 25, 100); // 85
    await mathTotal(x3, 50, 60);    // 30 + 42 = 72
    await mathTotal(x4, 50, 50);    // 30 + 35 = 65

    const { students } = await computeClassResults(I.jss2a, I.termA, I.schoolA);
    const pos = (id: string) => students.find(s => s.student_id === id)!.position;

    expect(students).toHaveLength(4);
    expect([pos(I.s1), pos(I.s2), pos(x3), pos(x4)]).toEqual([1, 1, 3, 4]);
    // Stated separately because it is the property dense ranking (1, 1, 2, 3) would break.
    expect(students.filter(s => s.position === 2)).toHaveLength(0);
  });

  it('averages over SCORED subjects only, so an unscored subject does not drag a student down', async () => {
    // s1: Maths 85, English 65 → 75. s2: Maths 80, English never entered → 80, not 40.
    await mathTotal(I.s1, 25, 100);           // 15 + 70 = 85
    await score(I.s1, I.ca1, 50, I.english);  // 30
    await score(I.s1, I.exam, 50, I.english); // + 35 = 65
    await mathTotal(I.s2, 40, 80);            // 24 + 56 = 80

    const { students } = await computeClassResults(I.jss2a, I.termA, I.schoolA);
    const s1 = students.find(s => s.student_id === I.s1)!;
    const s2 = students.find(s => s.student_id === I.s2)!;
    expect(s1.overall_average).toBe(75);
    expect(s2.overall_average).toBe(80);
    expect(s2.position).toBe(1);
  });
});
