/**
 * A term's assessment structure (audit, 8 Oct 2026, Fix first 4).
 *
 * Assessment configs belong to one term and nothing carried them forward. A school that set
 * CA and Exam for First Term opened Second Term with no structure: teachers saw students and
 * no columns, and every save said "This school has no assessment configuration set up", which
 * was untrue of the school and silent about the term.
 *
 * Now: creating a term copies the structure of the latest earlier term that has one (the
 * structure only, never scores); a term that exists without one can be given a copy; and a
 * teacher is told plainly that this term has not been set up.
 *
 * Alongside it (audit F4): a structure cannot be added to or removed from a term whose scores
 * already exist, since either would change how those scores are read; each change is audited;
 * and a structure names only this school's term and subject.
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import sessionsRoutes from '../routes/sessions';
import assessmentConfigRoutes from '../routes/assessmentConfig';
import scoresRoutes from '../routes/scores';
import { seed, tokens, IDS as I, pool } from './helpers';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription);
for (const r of [sessionsRoutes, assessmentConfigRoutes, scoresRoutes]) app.use('/api/schools', r);
app.use(errorHandler);

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const base = `/api/schools/${I.schoolA}`;
const SECOND_TERM = { name: 'Second Term', start_date: '2027-01-05', end_date: '2027-04-02' };

const createTerm = (tok = tokens.principalA(), body = SECOND_TERM, school = I.schoolA, session = I.sessionA) =>
  request(app).post(`/api/schools/${school}/sessions/${session}/terms`).set('Authorization', tok).send(body);

type Comp = { name: string; max_score: string; weight_percent: string; display_order: number };
async function structure(termId: string): Promise<Array<{ id: string; is_default: boolean; subject_id: string | null; class_level: string | null; components: Comp[] }>> {
  return (await owner.query(
    `SELECT ac.id, ac.is_default, ac.subject_id, ac.class_level,
            json_agg(json_build_object('name', c.name, 'max_score', c.max_score, 'weight_percent', c.weight_percent, 'display_order', c.display_order)
                     ORDER BY c.display_order) AS components
       FROM assessment_configs ac JOIN assessment_components c ON c.config_id = ac.id
      WHERE ac.term_id = $1 GROUP BY ac.id ORDER BY ac.is_default DESC, ac.subject_id NULLS FIRST`, [termId])).rows;
}

async function audits(action: string) {
  return (await owner.query<{ new_value: Record<string, unknown>; old_value: Record<string, unknown> | null }>(
    `SELECT new_value, old_value FROM audit_logs WHERE action_type = $1 ORDER BY created_at`, [action])).rows;
}

async function enterOneScore() {
  const res = await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tokens.math())
    .send({ subject_id: I.math, class_id: I.jss2a, term_id: I.termA, entries: [{ student_id: I.s1, component_id: I.ca1, score: 20 }] });
  expect(res.status).toBe(201);
}

/** A term with no structure, made directly so the term route's own copy does not run. */
async function bareTerm(name = 'Third Term', start = '2027-04-20', end = '2027-07-20'): Promise<string> {
  return (await owner.query<{ id: string }>(
    `INSERT INTO terms (session_id, school_id, name, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [I.sessionA, I.schoolA, name, start, end])).rows[0].id;
}

beforeEach(async () => { await seed(); });
afterAll(async () => { await pool.end(); await owner.end(); });

describe('a new term starts with the last term’s structure', () => {
  it('copies every config and its components, audited, leaving the earlier term and its scores alone', async () => {
    // A subject-specific structure too, so "every config" is more than the default.
    await owner.query(
      `WITH c AS (INSERT INTO assessment_configs (school_id, term_id, subject_id, is_default) VALUES ($1, $2, $3, false) RETURNING id)
       INSERT INTO assessment_components (config_id, name, max_score, weight_percent, display_order)
       SELECT c.id, 'Project', 40, 40, 1 FROM c UNION ALL SELECT c.id, 'Exam', 60, 60, 2 FROM c`,
      [I.schoolA, I.termA, I.english]);
    await enterOneScore();
    const before = await structure(I.termA);
    const scoresBefore = (await owner.query(`SELECT id, score FROM scores ORDER BY id`)).rows;

    const res = await createTerm();
    expect(res.status).toBe(201);
    expect(res.body.data.assessment_copied_from).toEqual({ term_id: I.termA, term_name: 'First Term', configs: 2 });

    const copied = await structure(res.body.data.id);
    const shape = (rows: typeof before) => rows.map(r => ({ is_default: r.is_default, subject_id: r.subject_id, class_level: r.class_level, components: r.components }));
    expect(shape(copied)).toEqual(shape(before));
    expect(copied.map(c => c.id)).not.toEqual(expect.arrayContaining(before.map(c => c.id)));

    expect(await structure(I.termA)).toEqual(before);
    expect((await owner.query(`SELECT id, score FROM scores ORDER BY id`)).rows).toEqual(scoresBefore);
    const scoresInNewTerm = await owner.query(`SELECT 1 FROM scores WHERE term_id = $1`, [res.body.data.id]);
    expect(scoresInNewTerm.rowCount).toBe(0);

    const [row] = await audits('ASSESSMENT_CONFIG_COPIED');
    expect(row.new_value).toMatchObject({ from_term_id: I.termA, to_term_id: res.body.data.id, configs: 2 });
  });

  it('a term with nothing earlier to copy starts empty, and says so', async () => {
    const res = await createTerm(tokens.principalB(), SECOND_TERM, I.schoolB, I.sessionB);
    expect(res.status).toBe(201);
    expect(res.body.data.assessment_copied_from).toBeNull();
    expect(await structure(res.body.data.id)).toEqual([]);
  });
});

describe('Copy from previous term', () => {
  it('gives a term without a structure a copy, once', async () => {
    const target = await bareTerm();
    const copy = () => request(app).post(`${base}/assessment-config/copy-from-term`).set('Authorization', tokens.principalA())
      .send({ from_term_id: I.termA, to_term_id: target });

    const first = await copy();
    expect(first.status).toBe(201);
    expect(first.body.data.configs).toBe(1);
    expect((await structure(target)).map(c => c.components.map(x => x.name))).toEqual([['CA1', 'Exam']]);
    expect(await audits('ASSESSMENT_CONFIG_COPIED')).toHaveLength(1);

    const again = await copy();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TARGET_HAS_CONFIG');
    expect(await structure(target)).toHaveLength(1);
  });

  it('refuses a term of another school, a source with nothing to copy, and anyone but the principal', async () => {
    const target = await bareTerm();
    const send = (tok: string, body: object) => request(app).post(`${base}/assessment-config/copy-from-term`).set('Authorization', tok).send(body);

    expect((await send(tokens.principalA(), { from_term_id: I.termB, to_term_id: target })).status).toBe(404);
    const empty = await bareTerm('Second Term', '2027-01-05', '2027-04-02');
    const nothing = await send(tokens.principalA(), { from_term_id: empty, to_term_id: target });
    expect(nothing.status).toBe(409);
    expect(nothing.body.error.code).toBe('NOTHING_TO_COPY');
    expect((await send(tokens.math(), { from_term_id: I.termA, to_term_id: target })).status).toBe(403);
    expect(await structure(target)).toEqual([]);
  });
});

describe('a teacher is told the term is not set up', () => {
  it('the score sheet says so, and a save names where it is set up', async () => {
    const term = await bareTerm();
    await owner.query(`INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1, $2, $3, $4, $5)`,
      [I.mathTeacher, I.jss2a, I.math, term, I.schoolA]);

    const sheetSet = await request(app).get(`${base}/scores/class-sheet`).set('Authorization', tokens.math())
      .query({ class_id: I.jss2a, subject_id: I.math, term_id: I.termA });
    expect(sheetSet.body.data.assessment_set).toBe(true);

    const sheet = await request(app).get(`${base}/scores/class-sheet`).set('Authorization', tokens.math())
      .query({ class_id: I.jss2a, subject_id: I.math, term_id: term });
    expect(sheet.status).toBe(200);
    expect(sheet.body.data.assessment_set).toBe(false);
    expect(sheet.body.data.components).toEqual([]);

    const save = await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tokens.math())
      .send({ subject_id: I.math, class_id: I.jss2a, term_id: term, entries: [{ student_id: I.s1, component_id: I.ca1, score: 20 }] });
    expect(save.body.error.code).toBe('NO_ASSESSMENT_CONFIG');
    expect(save.body.error.message).toMatch(/this term/i);
    expect(save.body.error.message).toMatch(/Settings → Assessment Config/);
  });
});

describe('a structure cannot change under scores (audit F4)', () => {
  const component = [{ name: 'Test', max_score: 100, weight_percent: 100, display_order: 1 }];
  const addConfig = (body: object) => request(app).post(`${base}/assessment-config`).set('Authorization', tokens.principalA()).send(body);

  it('a new structure for a term without scores is created and audited; with scores it is refused', async () => {
    const term = await bareTerm();
    const made = await addConfig({ term_id: term, is_default: true, components: component });
    expect(made.status).toBe(201);
    const [created] = await audits('ASSESSMENT_CONFIG_CREATED');
    expect(created.new_value).toMatchObject({ config_id: made.body.data.id, term_id: term });

    await enterOneScore();
    const refused = await addConfig({ term_id: I.termA, subject_id: I.math, components: component });
    expect(refused.status).toBe(423);
    expect(refused.body.error.code).toBe('CONFIG_LOCKED');
    expect(await structure(I.termA)).toHaveLength(1);
  });

  it("names only this school's term and subject", async () => {
    const other = await addConfig({ term_id: I.termB, is_default: true, components: component });
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('TERM_NOT_FOUND');

    const subjectB = (await owner.query<{ id: string }>(
      `INSERT INTO subjects (school_id, name, code) VALUES ($1, 'Physics', 'PHY') RETURNING id`, [I.schoolB])).rows[0].id;
    const term = await bareTerm();
    const foreignSubject = await addConfig({ term_id: term, subject_id: subjectB, components: component });
    expect(foreignSubject.status).toBe(404);
    expect(foreignSubject.body.error.code).toBe('SUBJECT_NOT_FOUND');
    expect(await structure(term)).toEqual([]);
  });

  it('a structure can be deleted until scores exist, and the deletion is audited with what it held', async () => {
    const term = await bareTerm();
    const made = await addConfig({ term_id: term, is_default: true, components: component });
    const del = await request(app).delete(`${base}/assessment-config/${made.body.data.id}`).set('Authorization', tokens.principalA());
    expect(del.status).toBe(200);
    expect(await structure(term)).toEqual([]);
    const [deleted] = await audits('ASSESSMENT_CONFIG_DELETED');
    expect(deleted.old_value).toMatchObject({ config_id: made.body.data.id, term_id: term });
    expect((deleted.old_value!.components as Comp[]).map(c => c.name)).toEqual(['Test']);

    await enterOneScore();
    const locked = await request(app).delete(`${base}/assessment-config/${I.configA}`).set('Authorization', tokens.principalA());
    expect(locked.status).toBe(423);
    expect(await structure(I.termA)).toHaveLength(1);
  });
});
