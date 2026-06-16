import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import pool from '../src/db/client';
import { computeStudentSubjectResult, computeClassResults } from '../src/services/resultEngine';

// ── Fixed test data (seeded) ───────────────────────────────────────────────────
const SCHOOL_ID = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const FATIMA_ID = '483dc14c-b865-45eb-99f9-fde8b2dbf16e';
const MATH_ID   = '9ddb5e1d-c3ce-4205-ad0e-9ec584656e2d';
const TERM_ID   = '3df9f000-f173-4307-a986-64516372c2a0';
const CLASS_ID  = '7a4dded1-ded1-4022-abde-a32d03cd359e';

// Fatima has all 4 components scored for Mathematics:
//   CA1=8/10×10=8, CA2=9/10×10=9, Mid-Term=7/10×10=7, Exam=58/70×70=58
//   total = 8 + 9 + 7 + 58 = 82.00
const EXPECTED_FATIMA_TOTAL = 82.00;

describe('resultEngine — database integration', () => {
  let emekaId: string;
  let ca1ComponentId: string;
  let fatimaUserId: string; // valid users.id to use as entered_by in test inserts
  let fatimaMathScores: { component_id: string; score: string }[]; // all 4 component scores, used to mirror Fatima's total for Emeka in Test 3

  beforeAll(async () => {
    // Fatima's user_id — valid FK for entered_by
    const fatimaUser = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM students WHERE id = $1`,
      [FATIMA_ID]
    );
    if (!fatimaUser.rows[0]) throw new Error('Fatima student record not found — seed the DB');
    fatimaUserId = fatimaUser.rows[0].user_id;

    // CA1 component ID — derived from Fatima's existing score row so it matches
    // the resolved assessment config for this subject+class+term
    const scoreRow = await pool.query<{ component_id: string }>(
      `SELECT component_id
       FROM scores
       WHERE student_id = $1 AND subject_id = $2 AND term_id = $3
       LIMIT 1`,
      [FATIMA_ID, MATH_ID, TERM_ID]
    );
    if (!scoreRow.rows[0]) {
      throw new Error(
        'Fatima has no score for Mathematics in this term — seed the score first'
      );
    }
    ca1ComponentId = scoreRow.rows[0].component_id;

    // All of Fatima's Mathematics component scores — mirrored onto Emeka in Test 3
    // to produce a genuine tie (both totals = 82.00)
    const fatimaScoresResult = await pool.query<{ component_id: string; score: string }>(
      `SELECT component_id, score::text AS score
       FROM scores
       WHERE student_id = $1 AND subject_id = $2 AND term_id = $3`,
      [FATIMA_ID, MATH_ID, TERM_ID]
    );
    fatimaMathScores = fatimaScoresResult.rows;

    // Emeka: any student enrolled in this class for this term's session, not Fatima
    const emekaRow = await pool.query<{ id: string }>(
      `SELECT s.id
       FROM students s
       JOIN users u ON u.id = s.user_id
       JOIN student_classes sc ON sc.student_id = s.id
       JOIN terms t ON t.session_id = sc.session_id
       WHERE s.school_id = $1
         AND sc.class_id = $2
         AND t.id        = $3
         AND s.id       != $4
         AND (u.first_name ILIKE 'Emeka' OR u.last_name ILIKE 'Emeka')
       LIMIT 1`,
      [SCHOOL_ID, CLASS_ID, TERM_ID, FATIMA_ID]
    );
    if (!emekaRow.rows[0]) {
      throw new Error(
        'Emeka not found enrolled in class 7a4dded1 for this term — seed the DB'
      );
    }
    emekaId = emekaRow.rows[0].id;
  }, 20000);

  afterEach(async () => {
    // Remove scores inserted for Emeka during each test; leave Fatima's intact
    if (emekaId) {
      await pool.query(
        `DELETE FROM scores WHERE student_id = $1 AND term_id = $2`,
        [emekaId, TERM_ID]
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  // ── Test 1 ────────────────────────────────────────────────────────────────────

  it(
    'computeStudentSubjectResult — Fatima: CA1 8/10 × weight 10 = total_score 8.00',
    async () => {
      const result = await computeStudentSubjectResult(FATIMA_ID, MATH_ID, TERM_ID, SCHOOL_ID);

      expect(result).not.toBeNull();
      expect(result!.total_score).toBe(EXPECTED_FATIMA_TOTAL);
      expect(result!.grade).not.toBe('N/A');   // grading scale lookup succeeded
      expect(result!.components.length).toBeGreaterThan(0);

      // The CA1 component contribution should equal 8/10 × 10 = 8.00
      const ca1 = result!.components.find(c => c.component_id === ca1ComponentId);
      expect(ca1).toBeDefined();
      expect(ca1!.score).toBe(8);
      expect(ca1!.contribution).toBe(8.00);
    },
    20000
  );

  // ── Test 2 ────────────────────────────────────────────────────────────────────

  it(
    'computeClassResults — distinct scores: higher average gets lower position number',
    async () => {
      // Emeka scores 6 on CA1 → total 6.00 < Fatima 82.00 → Fatima is ranked first
      await pool.query(
        `INSERT INTO scores
           (school_id, student_id, subject_id, term_id, component_id, score, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (student_id, term_id, component_id) DO UPDATE
           SET score = EXCLUDED.score, entered_by = EXCLUDED.entered_by`,
        [SCHOOL_ID, emekaId, MATH_ID, TERM_ID, ca1ComponentId, 6, fatimaUserId]
      );

      const result = await computeClassResults(CLASS_ID, TERM_ID, SCHOOL_ID);

      const fatima = result.students.find(s => s.student_id === FATIMA_ID);
      const emeka  = result.students.find(s => s.student_id === emekaId);

      expect(fatima).toBeDefined();
      expect(emeka).toBeDefined();

      expect(fatima!.overall_average).toBe(82.00);
      expect(emeka!.overall_average).toBe(6.00);

      // Fatima outscores Emeka → she holds position 1, Emeka holds position 2
      expect(fatima!.position).toBe(1);
      expect(emeka!.position).toBe(2);

      // Sanity: sorted order is descending by average
      const fatimaIdx = result.students.findIndex(s => s.student_id === FATIMA_ID);
      const emekaIdx  = result.students.findIndex(s => s.student_id === emekaId);
      expect(fatimaIdx).toBeLessThan(emekaIdx);
    },
    20000
  );

  // ── Test 3 ────────────────────────────────────────────────────────────────────

  it(
    'computeClassResults — tied positions: equal averages share rank, position 2 is skipped',
    async () => {
      // Emeka mirrors Fatima's full set of component scores (CA1=8, CA2=9, Mid-Term=7, Exam=58)
      // → both total_score 82.00 → tied at position 1
      // Standard competition ranking: next unique rank = 1 + 2 tied = 3 (position 2 skipped)
      for (const row of fatimaMathScores) {
        await pool.query(
          `INSERT INTO scores
             (school_id, student_id, subject_id, term_id, component_id, score, entered_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (student_id, term_id, component_id) DO UPDATE
             SET score = EXCLUDED.score, entered_by = EXCLUDED.entered_by`,
          [SCHOOL_ID, emekaId, MATH_ID, TERM_ID, row.component_id, row.score, fatimaUserId]
        );
      }

      const result = await computeClassResults(CLASS_ID, TERM_ID, SCHOOL_ID);

      const fatima = result.students.find(s => s.student_id === FATIMA_ID);
      const emeka  = result.students.find(s => s.student_id === emekaId);

      expect(fatima).toBeDefined();
      expect(emeka).toBeDefined();

      expect(fatima!.overall_average).toBe(82.00);
      expect(emeka!.overall_average).toBe(82.00);

      // Tied — both share position 1
      expect(fatima!.position).toBe(1);
      expect(emeka!.position).toBe(1);

      // Position 2 must not exist: it is skipped by standard competition ranking
      const atPosition2 = result.students.filter(s => s.position === 2);
      expect(atPosition2).toHaveLength(0);

      // Any remaining students (if class has more than 2) start at position 3
      const others = result.students.filter(
        s => s.student_id !== FATIMA_ID && s.student_id !== emekaId
      );
      for (const other of others) {
        expect(other.position).toBeGreaterThanOrEqual(3);
      }
    },
    20000
  );
});
