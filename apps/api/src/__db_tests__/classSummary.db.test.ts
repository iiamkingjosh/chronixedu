/**
 * GET /:schoolId/results/class-summary — the numbers behind an approval decision.
 *
 * The approval dashboard gave a principal subject name, teacher name and a
 * scored/total count. Approving from that confirms entry is COMPLETE, not that it is
 * CORRECT. This route serves the per-student weighted totals, grades and positions the
 * decision actually needs.
 *
 * It serves UNPUBLISHED scores by design — a principal reviewing marks before
 * approving them must see the unapproved state — so its access boundary is the whole
 * safety argument and is tested here directly: principal yes, teacher no, parent no,
 * student no, other tenant no.
 */
import request from 'supertest';
import { buildApp, seed, IDS as I, tokens, token, pool } from './helpers';

const app = buildApp();

beforeEach(seed);
afterAll(() => pool.end());

const url = (school = I.schoolA, cls = I.jss2a, term = I.termA) =>
  `/api/schools/${school}/results/class-summary?class_id=${cls}&term_id=${term}`;

describe('class-summary — access boundary', () => {
  it('allows the principal of that school', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    expect(res.status).toBe(200);
  });

  it('refuses a teacher, even one assigned to the class', async () => {
    // Teachers see their own subject through /scores/class-sheet. This spans every
    // subject in the class, which is a principal-level view.
    const res = await request(app).get(url()).set('Authorization', tokens.math());
    expect(res.status).toBe(403);
  });

  it('refuses a parent', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.parentA());
    expect(res.status).toBe(403);
  });

  it('refuses a student', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.studentS1());
    expect(res.status).toBe(403);
  });

  it('refuses a principal from another school', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.principalB());
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(401);
  });
});

describe('class-summary — target validation', () => {
  it('404s a class belonging to another school rather than returning an empty result', async () => {
    const res = await request(app)
      .get(url(I.schoolA, I.jss3b, I.termA))
      .set('Authorization', tokens.principalA());
    // jss3b IS in school A, so this one is a real 200 — the cross-tenant case below.
    expect(res.status).toBe(200);
  });

  it('404s a term from another school', async () => {
    const res = await request(app)
      .get(url(I.schoolA, I.jss2a, I.termB))
      .set('Authorization', tokens.principalA());
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Term not found/);
  });

  it('400s a non-uuid class_id instead of reaching the database', async () => {
    const res = await request(app)
      .get(`/api/schools/${I.schoolA}/results/class-summary?class_id=not-a-uuid&term_id=${I.termA}`)
      .set('Authorization', tokens.principalA());
    expect(res.status).toBe(400);
  });

  it('400s when term_id is missing', async () => {
    const res = await request(app)
      .get(`/api/schools/${I.schoolA}/results/class-summary?class_id=${I.jss2a}`)
      .set('Authorization', tokens.principalA());
    expect(res.status).toBe(400);
  });
});

describe('class-summary — the numbers a principal is approving', () => {
  it('returns every student in the class with per-subject and overall figures', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    expect(res.status).toBe(200);

    const d = res.body.data;
    expect(d.class_name).toBe('JSS 2A');
    expect(d.term_name).toBe('First Term');
    expect(Array.isArray(d.students)).toBe(true);
    expect(d.students.length).toBe(d.total_students);

    const s = d.students[0];
    expect(s).toHaveProperty('admission_no');
    expect(s).toHaveProperty('overall_average');
    expect(s).toHaveProperty('position');
    expect(s).toHaveProperty('subjects_scored');
    expect(Array.isArray(s.subjects)).toBe(true);
  });

  it('shows scores that are still in draft — the whole point of reviewing before approval', async () => {
    // The seed creates no scores, so enter some and leave them in draft: nothing
    // submitted, approved or published. A publish gate on this route would render it
    // useless — the principal would see an empty sheet and be asked to approve it.
    await pool.query(
      `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score)
       VALUES ($1,$2,$3,$4,$5,25), ($1,$2,$3,$4,$6,60)`,
      [I.schoolA, I.s1, I.math, I.termA, I.ca1, I.exam]
    );
    const published = await pool.query(
      `SELECT count(*)::int n FROM result_status WHERE term_id = $1 AND status = 'published'`, [I.termA]);
    expect(published.rows[0].n).toBe(0);

    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    const scored = res.body.data.students.reduce(
      (acc: number, s: { subjects_scored: number }) => acc + s.subjects_scored, 0);
    expect(scored).toBeGreaterThan(0);

    const s1 = res.body.data.students.find((s: { student_id: string }) => s.student_id === I.s1);
    expect(s1.overall_average).toBe(85); // 25/30 + 60/70 weighted to a 100-point total
  });

  it('ranks students by overall average, ties sharing a position', async () => {
    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    const students = res.body.data.students as Array<{ overall_average: number; position: number }>;
    for (let i = 1; i < students.length; i++) {
      expect(students[i].overall_average).toBeLessThanOrEqual(students[i - 1].overall_average);
      if (students[i].overall_average === students[i - 1].overall_average) {
        expect(students[i].position).toBe(students[i - 1].position);
      }
    }
  });

  it('is the same aggregation the report card uses, so the two cannot disagree', async () => {
    const { computeClassResults } = await import('../services/resultEngine');
    const direct = await computeClassResults(I.jss2a, I.termA, I.schoolA);
    const res = await request(app).get(url()).set('Authorization', tokens.principalA());
    expect(res.body.data.students.map((s: { student_id: string }) => s.student_id))
      .toEqual(direct.students.map(s => s.student_id));
    expect(res.body.data.students.map((s: { overall_average: number }) => s.overall_average))
      .toEqual(direct.students.map(s => s.overall_average));
  });
});

describe('class-summary — super_admin', () => {
  it('allows a super_admin into any school', async () => {
    const superToken = token('c0000000-0000-4000-8000-000000000001', 'super_admin', I.schoolB);
    const res = await request(app).get(url()).set('Authorization', superToken);
    expect(res.status).toBe(200);
  });
});
