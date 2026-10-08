/**
 * Analytics judge a pass against the school's own pass mark (audit, 8 Oct 2026).
 *
 * The pass rates, and the line drawn across the principal's subject chart, used a constant 40
 * (`PASS_MARK`), whatever the school had chosen, and whether or not it had chosen anything: the
 * `promotion_cutoff ?? 40` bug again, on a different screen (doctrine 8). Now each student is
 * judged against the pass mark of their class's level, else the school-wide one, and a student
 * with neither is not judged at all. With nothing set anywhere there is no pass rate.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { computeOverallPerformance, computeSubjectPerformance } from '../db/queries/analytics';
import { updateAcademicConfig } from '../db/queries/schools';

const app = buildApp();

// Math totals, with the seed's CA1 (max 50, weight 30) and Exam (max 100, weight 70):
//   s1: 25/50 → 15 + 60/100 → 42 = 57        s2: 50/50 → 30 + 30/100 → 21 = 51
beforeEach(async () => {
  await seed();
  const res = await request(app).post(`/api/schools/${I.schoolA}/scores/bulk-entry`).set('Authorization', tokens.math())
    .send({ subject_id: I.math, class_id: I.jss2a, term_id: I.termA, entries: [
      { student_id: I.s1, component_id: I.ca1, score: 25 }, { student_id: I.s1, component_id: I.exam, score: 60 },
      { student_id: I.s2, component_id: I.ca1, score: 50 }, { student_id: I.s2, component_id: I.exam, score: 30 },
    ] });
  expect(res.status).toBe(201);
});

afterAll(() => pool.end());

describe('pass rates', () => {
  it('are worked out against the school-wide pass mark', async () => {
    await updateAcademicConfig(I.schoolA, { promotion_cutoff: 55 });

    const overall = await computeOverallPerformance(I.schoolA, I.termA);
    expect(overall.school_average).toBe(54);
    expect(overall.pass_mark).toBe(55);
    expect(overall.pass_rate).toBe(50); // s1 (57) passes, s2 (51) does not; at a fixed 40 both would

    const [math] = await computeSubjectPerformance(I.schoolA, I.termA);
    expect(math.pass_rate).toBe(50);
  });

  it("a level's own pass mark wins for that level's students", async () => {
    // JSS 2A is level "Junior". Three readings, three answers: school-wide 58 fails both (0%),
    // Junior's 52 passes s1 only (50%), a fixed 40 passes both (100%).
    await updateAcademicConfig(I.schoolA, { promotion_cutoff: 58, level_overrides: { Junior: { promotion_cutoff: 52 } } });

    expect((await computeOverallPerformance(I.schoolA, I.termA)).pass_rate).toBe(50);
    expect((await computeSubjectPerformance(I.schoolA, I.termA))[0].pass_rate).toBe(50);
  });

  it('with no pass mark set there is no pass rate, rather than one judged against 40', async () => {
    // Control: the averages are there, so "no pass rate" is about the pass mark, not missing scores.
    const overall = await computeOverallPerformance(I.schoolA, I.termA);
    expect(overall.school_average).toBe(54);
    expect(overall.pass_mark).toBeNull();
    expect(overall.pass_rate).toBeNull();

    const [math] = await computeSubjectPerformance(I.schoolA, I.termA);
    expect(math.average).toBe(54);
    expect(math.pass_rate).toBeNull();
  });

  it('a level override that sets only a grading scale leaves the school-wide pass mark in force', async () => {
    const scale = [{ grade: 'P', min: 0, max: 100, label: 'Pass', remark: '' }];
    await updateAcademicConfig(I.schoolA, { promotion_cutoff: 55, level_overrides: { Junior: { grading_scale: scale } } });
    expect((await computeOverallPerformance(I.schoolA, I.termA)).pass_rate).toBe(50);
  });
});
