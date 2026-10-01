/**
 * Onboarding is five steps since 1 Oct 2026 — Info, Branding, Calendar, Admin, Review — with
 * ONE term (the current one) and no grading or assessment step. And the point of the change
 * (doctrine 8): a new school has NO grading scale, pass mark or assessment components until
 * its principal sets them. Nothing seeds them, so nothing is silently "chosen" — and an unset
 * scale is visibly unset: publishing refuses, naming what is missing.
 *
 * Two properties, each asserted with its success half first:
 *   1. a school is created end to end with only one current term — and the settings row the
 *      wizard wrote holds no grading scale, pass mark or components;
 *   2. a class whose school has no grading scale cannot publish, and the refusal says
 *      grading scale — then, the scale set through the real settings route, the same class
 *      publishes. "Publish failed" alone would not show the right reason.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';

// The principal step creates a Supabase Auth account; /complete sends a welcome email.
// Both are external services — mocked at that boundary only.
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: { createUser: jest.fn(async () => ({ data: { user: { id: 'd1d1d1d1-0000-4000-8000-000000000001' } }, error: null })) } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => undefined),
  isEmailConfigured: jest.fn(() => false),
}));

const wizard = express();
wizard.use(express.json());
wizard.use('/api/super-admin', superAdminRoutes);
wizard.use(errorHandler);
const app = buildApp();

const SUPER = 'c0000000-0000-4000-8000-000000000003';
const auth = () => 'Bearer ' + jwt.sign({ user_id: SUPER, school_id: null, role: 'super_admin', email: 'wizard@test' }, process.env.JWT_SECRET!);

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
     VALUES ($1, NULL, 'wizard@test', 'x', 'super_admin', 'Wiz', 'Ard')`, [SUPER]);
});
afterAll(async () => { await pool.end(); });

describe('the five-step wizard', () => {
  const step = (sessionId: string, n: number, body: object) =>
    request(wizard).patch(`/api/super-admin/onboarding/${sessionId}/step/${n}`).set('Authorization', auth()).send(body);

  it('creates a school end to end with only one current term, and seeds no grading scale, pass mark or components', async () => {
    const start = await request(wizard).post('/api/super-admin/onboarding').set('Authorization', auth())
      .send({ school_name: 'Five Step School', school_email: 'office@fivestep.test', is_demo: true });
    expect(start.status).toBe(201);
    const { session_id: sid, school_id: schoolId } = start.body.data;

    expect((await step(sid, 1, { name: 'Five Step School', address: '1 Road', phone: '08000000000' })).status).toBe(200);
    expect((await step(sid, 2, { motto: 'Onward' })).status).toBe(200);
    expect((await step(sid, 3, { session_name: '2026/2027', term: { name: 'First Term', start_date: '2026-09-14', end_date: '2026-12-18' } })).status).toBe(200);
    expect((await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'principal@fivestep.test' })).status).toBe(200);
    const done = await request(wizard).post(`/api/super-admin/onboarding/${sid}/complete`).set('Authorization', auth()).send({ accepted_legal_terms: true });
    expect(done.status).toBe(200);

    expect((await pool.query(`SELECT is_active FROM schools WHERE id = $1`, [schoolId])).rows[0].is_active).toBe(true);
    const terms = (await pool.query(
      `SELECT t.name, t.is_current, s.is_current AS session_current FROM terms t JOIN academic_sessions s ON s.id = t.session_id WHERE t.school_id = $1`, [schoolId])).rows;
    expect(terms).toEqual([{ name: 'First Term', is_current: true, session_current: true }]);

    // The settings row exists (step 2 wrote it), and decides nothing on the school's behalf.
    const cfg = (await pool.query(`SELECT academic_config FROM school_settings WHERE school_id = $1`, [schoolId])).rows[0].academic_config;
    expect(cfg).toBeTruthy();
    expect(cfg).not.toHaveProperty('grading_scale');
    expect(cfg).not.toHaveProperty('promotion_cutoff');
    expect(cfg).not.toHaveProperty('assessment_components');
  });

  it('takes one term, not three, and the removed steps are gone', async () => {
    const start = await request(wizard).post('/api/super-admin/onboarding').set('Authorization', auth())
      .send({ school_name: 'Old Shape School', school_email: 'office@oldshape.test', is_demo: true });
    const sid = start.body.data.session_id;
    const threeTerms = await step(sid, 3, { session_name: '2026/2027', terms: [
      { name: 'First Term', start_date: '2026-09-14', end_date: '2026-12-18' },
      { name: 'Second Term', start_date: '2027-01-05', end_date: '2027-04-02' },
    ] });
    expect(threeTerms.status).toBe(400);
    for (const n of [5, 6, 7]) expect((await step(sid, n, {})).body.error.code).toBe('INVALID_STEP');
  });

  it('cannot complete until steps 1-4 are done, and says which are missing', async () => {
    const start = await request(wizard).post('/api/super-admin/onboarding').set('Authorization', auth())
      .send({ school_name: 'Half Done School', school_email: 'office@halfdone.test', is_demo: true });
    const sid = start.body.data.session_id;
    await step(sid, 1, { name: 'Half Done School', address: '1 Road', phone: '08000000000' });
    const res = await request(wizard).post(`/api/super-admin/onboarding/${sid}/complete`).set('Authorization', auth()).send({ accepted_legal_terms: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INCOMPLETE_WIZARD', message: 'Steps 2, 3, 4 are not yet complete' });
  });
});

describe('no grading scale, no publishing', () => {
  const base = `/api/schools/${I.schoolA}`;
  const fullMarks = () => [I.s1, I.s2].flatMap(student_id => [
    { student_id, component_id: I.ca1, score: 25 },
    { student_id, component_id: I.exam, score: 60 },
  ]);
  const publish = () => request(app).post(`${base}/results/publish`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });

  it('refuses with GRADING_SCALE_NOT_SET until the scale is set — then the same class publishes', async () => {
    // Everything else publishing needs, done and asserted: scores, submissions, approval.
    for (const [tok, subject] of [[tokens.math(), I.math], [tokens.english(), I.english]] as const) {
      await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok)
        .send({ subject_id: subject, class_id: I.jss2a, term_id: I.termA, entries: fullMarks() });
      await request(app).post(`${base}/results/submit`).set('Authorization', tok)
        .send({ class_id: I.jss2a, subject_id: subject, term_id: I.termA });
    }
    const approved = await request(app).post(`${base}/results/approve`).set('Authorization', tokens.principalA())
      .send({ class_id: I.jss2a, term_id: I.termA });
    expect(approved.status).toBe(200);

    const refused = await publish();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('GRADING_SCALE_NOT_SET');
    expect(refused.body.error.missing).toBe('grading_scale');
    expect(refused.body.error.message).toMatch(/grading scale/i);
    const statuses = (await pool.query(`SELECT DISTINCT status FROM result_status WHERE school_id = $1 AND term_id = $2`, [I.schoolA, I.termA])).rows;
    expect(statuses).toEqual([{ status: 'approved' }]); // nothing was published

    // The principal sets the scale through the settings route — and the same class publishes.
    const set = await request(app).patch(`${base}/academic-config`).set('Authorization', tokens.principalA()).send({
      grading_scale: [
        { grade: 'A', min: 70, max: 100, label: 'Excellent', remark: 'Excellent' },
        { grade: 'C', min: 40, max: 69, label: 'Credit', remark: 'Credit' },
        { grade: 'F', min: 0, max: 39, label: 'Fail', remark: 'Fail' },
      ],
    });
    expect(set.status).toBe(200);
    const ok = await publish();
    expect(ok.status).toBe(200);
    expect(ok.body.data.published_students).toBe(2);
  });
});
