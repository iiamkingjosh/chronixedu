/**
 * AUDIT C-1 / C-2 regression: scores are per subject, and submission is per
 * class + subject. Each test here failed against the pre-audit code.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

const bulk = (tok: string, subject_id: string, entries: Array<{ student_id: string; component_id: string; score: number }>) =>
  request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok)
    .send({ subject_id, class_id: I.jss2a, term_id: I.termA, entries });

const fullMarks = (ca: number, exam: number) => [I.s1, I.s2].flatMap(student_id => [
  { student_id, component_id: I.ca1, score: ca },
  { student_id, component_id: I.exam, score: exam },
]);

const submit = (tok: string, subject_id: string) =>
  request(app).post(`${base}/results/submit`).set('Authorization', tok)
    .send({ class_id: I.jss2a, subject_id, term_id: I.termA });

const classAction = (action: 'approve' | 'publish', body: Record<string, unknown> = {}) =>
  request(app).post(`${base}/results/${action}`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA, ...body });

beforeEach(seed);
afterAll(() => pool.end());

describe('C-1: scores are unique per subject', () => {
  it('English exam score does not overwrite the Math exam score', async () => {
    expect((await bulk(tokens.math(), I.math, fullMarks(25, 66))).status).toBe(201);
    expect((await bulk(tokens.english(), I.english, fullMarks(10, 40))).status).toBe(201);

    const { rows } = await pool.query(
      `SELECT subject_id, component_id, score::float AS score FROM scores WHERE student_id = $1 ORDER BY subject_id, component_id`,
      [I.s1]
    );
    expect(rows).toHaveLength(4);
    const math = rows.filter(r => r.subject_id === I.math).map(r => r.score).sort();
    const eng = rows.filter(r => r.subject_id === I.english).map(r => r.score).sort();
    expect(math).toEqual([25, 66]);
    expect(eng).toEqual([10, 40]);
  });

  it('single-entry update touches only its own subject', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66));
    const r = await request(app).post(`${base}/scores/entry`).set('Authorization', tokens.english())
      .send({ student_id: I.s1, subject_id: I.english, class_id: I.jss2a, term_id: I.termA, component_id: I.exam, score: 12 });
    expect(r.status).toBe(201);
    const { rows } = await pool.query(`SELECT score::float AS score FROM scores WHERE student_id=$1 AND subject_id=$2 AND component_id=$3`, [I.s1, I.math, I.exam]);
    expect(rows[0].score).toBe(66);
  });
});

describe('C-2: submission is per class + subject', () => {
  it('one teacher submitting does not lock another subject', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66));
    expect((await submit(tokens.math(), I.math)).status).toBe(200);

    const eng = await bulk(tokens.english(), I.english, fullMarks(10, 40));
    expect(eng.status).toBe(201);

    const mathAgain = await bulk(tokens.math(), I.math, fullMarks(1, 1));
    expect(mathAgain.status).toBe(423);
    expect(mathAgain.body.error.code).toBe('SUBJECT_SUBMITTED');
  });

  it('principal cannot approve until every assigned subject is submitted', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66));
    await submit(tokens.math(), I.math);

    const early = await classAction('approve');
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('NOT_ALL_SUBMITTED');
    expect(early.body.error.not_submitted.map((s: { subject_id: string }) => s.subject_id)).toEqual([I.english]);

    const publishEarly = await classAction('publish');
    expect(publishEarly.status).toBe(400);

    await bulk(tokens.english(), I.english, fullMarks(10, 40));
    expect((await submit(tokens.english(), I.english)).status).toBe(200);

    expect((await classAction('approve')).status).toBe(200);
    expect((await classAction('publish')).status).toBe(200);

    const { rows } = await pool.query(`SELECT DISTINCT status FROM result_status WHERE term_id = $1`, [I.termA]);
    expect(rows).toEqual([{ status: 'published' }]);
  });

  it('cannot submit a subject with missing scores', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66).slice(0, 3));
    const r = await submit(tokens.math(), I.math);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INCOMPLETE_SCORES');
  });

  it('approved results lock every subject; returning one subject unlocks only that subject', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66));
    await bulk(tokens.english(), I.english, fullMarks(10, 40));
    await submit(tokens.math(), I.math);
    await submit(tokens.english(), I.english);
    expect((await classAction('approve')).status).toBe(200);

    const locked = await request(app).post(`${base}/scores/entry`).set('Authorization', tokens.english())
      .send({ student_id: I.s1, subject_id: I.english, class_id: I.jss2a, term_id: I.termA, component_id: I.exam, score: 5 });
    expect(locked.status).toBe(423);

    const ret = await classAction('return' as 'approve', { subject_id: I.english, reason: 'English exam totals need a recount' });
    expect(ret.status).toBe(200);
    expect(ret.body.data.reset_subjects).toBe(1);

    expect((await bulk(tokens.english(), I.english, fullMarks(11, 41))).status).toBe(201);
    const mathStill = await bulk(tokens.math(), I.math, fullMarks(1, 1));
    expect(mathStill.status).toBe(423);

    const { rows } = await pool.query(`SELECT DISTINCT status FROM result_status WHERE term_id = $1`, [I.termA]);
    expect(rows).toEqual([{ status: 'draft' }]);
  });

  it('published results cannot be returned', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66));
    await bulk(tokens.english(), I.english, fullMarks(10, 40));
    await submit(tokens.math(), I.math);
    await submit(tokens.english(), I.english);
    await classAction('approve');
    await classAction('publish');
    const r = await classAction('return' as 'approve', { reason: 'Trying to reopen published results' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('RESULTS_PUBLISHED');
  });

  it('teacher dashboard reports submission per subject, not per class', async () => {
    await bulk(tokens.math(), I.math, fullMarks(25, 66));
    await submit(tokens.math(), I.math);
    const r = await request(app).get(`${base}/dashboard/teacher/score-entry-status`).set('Authorization', tokens.english());
    expect(r.status).toBe(200);
    const rows = Array.isArray(r.body.data) ? r.body.data : r.body.data.assignments ?? r.body.data.items ?? [];
    const eng = rows.find((x: { subject_id: string }) => x.subject_id === I.english);
    expect(eng?.result_status).toBe('draft');
  });
});
