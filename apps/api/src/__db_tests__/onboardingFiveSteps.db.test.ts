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

// The principal step creates a Supabase Auth account; /complete makes a set-password link and sends
// a welcome email. All external services, mocked at that boundary only.
const SET_PASSWORD_LINK = 'https://auth.example.test/verify?type=recovery&token=one-time-token';
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    createUser: jest.fn(async () => ({ data: { user: { id: 'd1d1d1d1-0000-4000-8000-000000000001' } }, error: null })),
    generateLink: jest.fn(async () => ({ data: { properties: { action_link: 'https://auth.example.test/verify?type=recovery&token=one-time-token' } }, error: null })),
  } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => false),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const { supabaseAdmin } = require('../supabaseClient');
const emailService = require('../services/emailService');
/* eslint-enable @typescript-eslint/no-var-requires */

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
    expect((await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'principal@fivestep.test', email_confirmation: 'principal@fivestep.test' })).status).toBe(200);
    const done = await request(wizard).post(`/api/super-admin/onboarding/${sid}/complete`).set('Authorization', auth()).send({ accepted_legal_terms: true, principal_email_read_back: true });
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

  it('motto is optional, as the form says: blank or omitted both save', async () => {
    const start = await request(wizard).post('/api/super-admin/onboarding').set('Authorization', auth())
      .send({ school_name: 'No Motto School', school_email: 'office@nomotto.test', is_demo: true });
    const sid = start.body.data.session_id;
    // Exactly what the form sends when the motto box is left empty.
    const blank = await step(sid, 2, { motto: '', primary_colour: '#003366', admission_prefix: 'NMS' });
    expect(blank.status).toBe(200);
    const omitted = await step(sid, 2, { primary_colour: '#003366', admission_prefix: 'NMS' });
    expect(omitted.status).toBe(200);
    const identity = (await pool.query(`SELECT identity_config FROM school_settings WHERE school_id = $1`, [start.body.data.school_id])).rows[0].identity_config;
    expect(identity.admission_prefix).toBe('NMS');
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
    const res = await request(wizard).post(`/api/super-admin/onboarding/${sid}/complete`).set('Authorization', auth()).send({ accepted_legal_terms: true, principal_email_read_back: true });
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

describe("the principal's address: typed twice, read back, and given a link, never a password (item H)", () => {
  // A mistyped address ties the principal account to a stranger's mailbox, and "Forgot password"
  // then sends the reset there. Typing it twice catches typos; reading it back to the principal by
  // phone closes the rest, and the system records who said so; a set-password link means nobody
  // sees or relays a password, and a wrong address shows at once (the principal gets nothing).
  const step = (sessionId: string, n: number, body: object) =>
    request(wizard).patch(`/api/super-admin/onboarding/${sessionId}/step/${n}`).set('Authorization', auth()).send(body);
  const complete = (sessionId: string, body: object) =>
    request(wizard).post(`/api/super-admin/onboarding/${sessionId}/complete`).set('Authorization', auth()).send(body);

  async function throughStep3(name: string) {
    const start = await request(wizard).post('/api/super-admin/onboarding').set('Authorization', auth())
      .send({ school_name: name, school_email: `office@${name.toLowerCase().replace(/ /g, '')}.test`, is_demo: true });
    const sid = start.body.data.session_id;
    await step(sid, 1, { name, address: '1 Road', phone: '08000000000' });
    await step(sid, 2, { motto: 'Onward' });
    await step(sid, 3, { session_name: '2026/2027', term: { name: 'First Term', start_date: '2026-09-14', end_date: '2026-12-18' } });
    return { sid, schoolId: start.body.data.school_id as string };
  }
  const principalCount = async (schoolId: string) =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM users WHERE school_id = $1 AND role = 'principal'`, [schoolId])).rows[0].n;
  const readBackRows = async (schoolId: string) =>
    (await pool.query(`SELECT platform_admin_id, metadata FROM platform_audit_logs WHERE target_school_id = $1 AND action_type = 'PRINCIPAL_EMAIL_READ_BACK_CONFIRMED'`, [schoolId])).rows;

  beforeEach(() => {
    jest.clearAllMocks();
    (emailService.isEmailConfigured as jest.Mock).mockReturnValue(false);
  });

  it('refuses a confirmation that does not match, creating nothing; a matching one creates the principal', async () => {
    const { sid, schoolId } = await throughStep3('Typo School');

    const typo = await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada.obi@typo.test', email_confirmation: 'ada.obi@typo.tset' });
    expect(typo.status).toBe(400);
    expect(typo.body.error.message.fieldErrors.email_confirmation).toEqual(['The two email addresses do not match']);
    expect(await principalCount(schoolId)).toBe(0);
    expect(supabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();

    const ok = await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada.obi@typo.test', email_confirmation: ' Ada.Obi@typo.test ' });
    expect(ok.status).toBe(200);
    expect(await principalCount(schoolId)).toBe(1);
  });

  it('creates the account with no password, and returns none for the operator to pass on', async () => {
    const { sid } = await throughStep3('Link Only School');
    const res = await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@linkonly.test', email_confirmation: 'ada@linkonly.test' });

    expect(res.status).toBe(200);
    expect(res.body.data.principal_created).toBe(true);
    expect(res.body.data).not.toHaveProperty('temp_password');
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    const [created] = supabaseAdmin.auth.admin.createUser.mock.calls[0];
    expect(created).toEqual({ email: 'ada@linkonly.test', email_confirm: true });
  });

  it('will not complete until the operator states the address was read back; then records who, which address and when', async () => {
    const { sid, schoolId } = await throughStep3('Read Back School');
    await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@readback.test', email_confirmation: 'ada@readback.test' });

    for (const body of [{ accepted_legal_terms: true }, { accepted_legal_terms: true, principal_email_read_back: false }]) {
      const refused = await complete(sid, body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('PRINCIPAL_EMAIL_NOT_READ_BACK');
    }
    expect((await pool.query(`SELECT is_active FROM schools WHERE id = $1`, [schoolId])).rows[0].is_active).toBe(false);
    expect(await readBackRows(schoolId)).toEqual([]);

    const done = await complete(sid, { accepted_legal_terms: true, principal_email_read_back: true });
    expect(done.status).toBe(200);
    const rows = await readBackRows(schoolId);
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_admin_id).toBe(SUPER);
    expect(rows[0].metadata).toMatchObject({ principal_email: 'ada@readback.test', asserted_confirmed: true });
  });

  it('emails a set-password link, not a password, to the address that was confirmed', async () => {
    (emailService.isEmailConfigured as jest.Mock).mockReturnValue(true);
    const { sid } = await throughStep3('Link School');
    await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@link.test', email_confirmation: 'ada@link.test' });

    const done = await complete(sid, { accepted_legal_terms: true, principal_email_read_back: true });
    expect(done.status).toBe(200);
    expect(done.body.data.welcome_email).toBe('sent');

    expect(supabaseAdmin.auth.admin.generateLink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recovery', email: 'ada@link.test', options: { redirectTo: expect.stringMatching(/\/reset-password$/) },
    }));
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, , body] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(to).toBe('ada@link.test');
    expect(body).toContain(SET_PASSWORD_LINK);
    expect(body).not.toMatch(/temporary password/i);
  });

  it("sends the principal to APP_URL, not to NEXTAUTH_URL's leftover localhost, in text and HTML", async () => {
    // On 2 Oct 2026 production's onboarding email sent a new school to http://localhost:3000 four
    // times: the route read NEXTAUTH_URL, a leftover, while everything else read APP_URL.
    const saved = { APP_URL: process.env.APP_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
    process.env.APP_URL = 'https://app.example.test';
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    try {
      (emailService.isEmailConfigured as jest.Mock).mockReturnValue(true);
      const { sid } = await throughStep3('Address School');
      await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@address.test', email_confirmation: 'ada@address.test' });
      const done = await complete(sid, { accepted_legal_terms: true, principal_email_read_back: true });
      expect(done.status).toBe(200);

      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      const [, , text, html] = (emailService.sendEmail as jest.Mock).mock.calls[0];
      for (const part of [text, html]) {
        expect(part).toContain('https://app.example.test/login');
        expect(part).toContain('https://app.example.test/legal');
        expect(part).not.toContain('localhost');
      }
      expect(text).toContain(SET_PASSWORD_LINK);
      expect(html).toContain(`href="${SET_PASSWORD_LINK.replace(/&/g, '&amp;')}"`);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('says NOT sent, and why, when SendGrid refuses the email: sendEmail returns normally either way', async () => {
    (emailService.isEmailConfigured as jest.Mock).mockReturnValue(true);
    (emailService.sendEmail as jest.Mock).mockResolvedValueOnce('queued');
    const { sid } = await throughStep3('Refused School');
    await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@refused.test', email_confirmation: 'ada@refused.test' });

    const done = await complete(sid, { accepted_legal_terms: true, principal_email_read_back: true });
    expect(done.status).toBe(200);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(done.body.data.welcome_email).toBe('not_sent');
    expect(done.body.data.message).toMatch(/NOT sent: the email service refused it/);
  });

  it('says so, and prints nothing, when email is not configured', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sid } = await throughStep3('Unsent School');
    await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@unsent.test', email_confirmation: 'ada@unsent.test' });

    const done = await complete(sid, { accepted_legal_terms: true, principal_email_read_back: true });
    expect(done.status).toBe(200);
    expect(done.body.data.welcome_email).toBe('not_sent');
    expect(done.body.data.message).toMatch(/NOT sent/);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    // The body carries a working link; it used to be console.logged whole.
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(SET_PASSWORD_LINK);
    consoleSpy.mockRestore();
  });

  it('activates nothing when Supabase cannot make the link', async () => {
    supabaseAdmin.auth.admin.generateLink.mockResolvedValueOnce({ data: null, error: { message: 'auth service unavailable' } });
    const { sid, schoolId } = await throughStep3('No Link School');
    await step(sid, 4, { first_name: 'Ada', last_name: 'Obi', email: 'ada@nolink.test', email_confirmation: 'ada@nolink.test' });

    const res = await complete(sid, { accepted_legal_terms: true, principal_email_read_back: true });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SET_PASSWORD_LINK_FAILED');
    expect((await pool.query(`SELECT is_active FROM schools WHERE id = $1`, [schoolId])).rows[0].is_active).toBe(false);
    expect((await pool.query(`SELECT status FROM onboarding_sessions WHERE id = $1`, [sid])).rows[0].status).toBe('in_progress');
  });
});
