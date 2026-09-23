/**
 * AUDIT R10-H1 / R10-H2 regression.
 *
 * H1: parents and students must not see scores until the student's result for the
 *     term is PUBLISHED (doctrine 5). Before this fix both roles saw scores the
 *     moment a teacher typed them — the routes fetched result_status but only
 *     echoed it back, never gating on it. Every H1 test below fails on the old code.
 *
 * H2: locks in that GET /:schoolId/users stays admin-only. It was ALREADY admin-only
 *     via this file's own requireSchoolAccess helper (super_admin/principal), which
 *     is easy to miss because every other route file defines a permissive helper of
 *     the same name — an audit pass misread it as an open endpoint. These tests exist
 *     so the real behaviour is pinned down and the next reader doesn't have to guess.
 *     Also covers GET /users/me, added because the teacher class-comments signature
 *     lookup had been silently 403-ing against the admin-only directory.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

const fullMarks = () => [I.s1, I.s2].flatMap(student_id => [
  { student_id, component_id: I.ca1, score: 25 },
  { student_id, component_id: I.exam, score: 60 },
]);

/** Enter + submit both subjects, then approve and (optionally) publish the class. */
async function progressResults(opts: { publish: boolean }) {
  for (const [tok, subject] of [[tokens.math(), I.math], [tokens.english(), I.english]] as const) {
    await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok)
      .send({ subject_id: subject, class_id: I.jss2a, term_id: I.termA, entries: fullMarks() });
    await request(app).post(`${base}/results/submit`).set('Authorization', tok)
      .send({ class_id: I.jss2a, subject_id: subject, term_id: I.termA });
  }
  await request(app).post(`${base}/results/approve`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });
  if (opts.publish) {
    await request(app).post(`${base}/results/publish`).set('Authorization', tokens.principalA())
      .send({ class_id: I.jss2a, term_id: I.termA });
  }
}

const parentResults = () =>
  request(app).get(`${base}/parent/students/${I.s1}/results?term_id=${I.termA}`)
    .set('Authorization', tokens.parentA());

const parentSnapshot = () =>
  request(app).get(`${base}/parent/students/${I.s1}/snapshot?term_id=${I.termA}`)
    .set('Authorization', tokens.parentA());

const studentResults = () =>
  request(app).get(`${base}/student/results?term_id=${I.termA}`)
    .set('Authorization', tokens.studentS1());

const studentDashboard = () =>
  request(app).get(`${base}/student/dashboard?term_id=${I.termA}`)
    .set('Authorization', tokens.studentS1());

beforeEach(seed);
afterAll(() => pool.end());

describe('H1: unpublished results are hidden from parents', () => {
  it('hides scores that have only been entered, never submitted', async () => {
    await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tokens.math())
      .send({ subject_id: I.math, class_id: I.jss2a, term_id: I.termA, entries: fullMarks() });

    const r = await parentResults();
    expect(r.status).toBe(200);
    expect(r.body.data.subjects).toEqual([]);
    expect(r.body.data.overall_average).toBe(0);
    expect(r.body.data.position).toBe(0);
  });

  it('still hides scores after the principal approves but before publishing', async () => {
    await progressResults({ publish: false });

    const r = await parentResults();
    expect(r.status).toBe(200);
    expect(r.body.data.result_status).toBe('approved');
    expect(r.body.data.subjects).toEqual([]);
  });

  it('reveals scores once published', async () => {
    await progressResults({ publish: true });

    const r = await parentResults();
    expect(r.status).toBe(200);
    expect(r.body.data.result_status).toBe('published');
    expect(r.body.data.subjects.length).toBe(2);
    expect(r.body.data.overall_average).toBeGreaterThan(0);
  });

  it('applies the same gate to the dashboard snapshot', async () => {
    await progressResults({ publish: false });
    const before = await parentSnapshot();
    expect(before.body.data.academic).toBeNull();
    expect(before.body.data.recent_results).toEqual([]);

    await request(app).post(`${base}/results/publish`).set('Authorization', tokens.principalA())
      .send({ class_id: I.jss2a, term_id: I.termA });

    const after = await parentSnapshot();
    expect(after.body.data.academic).not.toBeNull();
    expect(after.body.data.recent_results.length).toBe(2);
  });
});

describe('H1: unpublished results are hidden from students', () => {
  it('hides approved-but-unpublished scores on both student routes', async () => {
    await progressResults({ publish: false });

    const results = await studentResults();
    expect(results.status).toBe(200);
    expect(results.body.data.subjects).toEqual([]);

    const dash = await studentDashboard();
    expect(dash.status).toBe(200);
    expect(dash.body.data.academic).toBeNull();
    expect(dash.body.data.subjects).toEqual([]);
  });

  it('reveals scores on both student routes once published', async () => {
    await progressResults({ publish: true });

    const results = await studentResults();
    expect(results.body.data.subjects.length).toBe(2);

    const dash = await studentDashboard();
    expect(dash.body.data.academic).not.toBeNull();
    expect(dash.body.data.subjects.length).toBe(2);
  });
});

describe('H2: the school user directory is and stays admin-only', () => {
  it.each([
    ['teacher', () => tokens.math()],
    ['parent', () => tokens.parentA()],
    ['student', () => tokens.studentS1()],
  ])('refuses %s', async (_role, tok) => {
    const r = await request(app).get(`${base}/users?role=parent`).set('Authorization', tok());
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the principal, and still returns contact details to them', async () => {
    const r = await request(app).get(`${base}/users?role=parent`).set('Authorization', tokens.principalA());
    expect(r.status).toBe(200);
    expect(r.body.data.users.length).toBeGreaterThan(0);
    expect(r.body.data.users[0]).toHaveProperty('email');
  });

  it('lets any role read its own record via /users/me without exposing others', async () => {
    const r = await request(app).get(`${base}/users/me`).set('Authorization', tokens.math());
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(I.mathTeacher);
    expect(Array.isArray(r.body.data)).toBe(false);
  });
});
