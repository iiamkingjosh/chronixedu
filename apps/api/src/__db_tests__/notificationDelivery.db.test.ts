/**
 * A queued parent notification reaches the parents it names (audit, 8 Oct 2026, Fix first 1).
 *
 * POST /results/publish queues ONE row for the whole class, naming its students in
 * `new_value.student_ids`. The worker read only `new_value.student_id`, the shape the
 * attendance and behaviour rows use, found none, marked the row processed and told nobody.
 * In production the pilot school's parent never got a "results published" notice, and the
 * queue row said it had been handled.
 *
 * Each case below first shows a parent being told, so "nobody was told" in the refusals is
 * about the rule and not about a worker that does nothing (doctrine 16).
 */
import request from 'supertest';
import { Pool } from 'pg';
import * as emailService from '../services/emailService';
import { processNotificationQueue } from '../services/notificationWorker';
import { buildApp, seed, setGradingScale, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

const SECOND_PARENT = '30000000-0000-4000-8000-000000000098'; // parent of s2 only
const PARENT_B = '30000000-0000-4000-8000-000000000097';      // parent of School B's student

let emailSpy: jest.SpyInstance;

const fullMarks = () => [I.s1, I.s2].flatMap(student_id => [
  { student_id, component_id: I.ca1, score: 25 },
  { student_id, component_id: I.exam, score: 60 },
]);

async function publishClass() {
  for (const [tok, subject] of [[tokens.math(), I.math], [tokens.english(), I.english]] as const) {
    await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok)
      .send({ subject_id: subject, class_id: I.jss2a, term_id: I.termA, entries: fullMarks() });
    await request(app).post(`${base}/results/submit`).set('Authorization', tok)
      .send({ class_id: I.jss2a, subject_id: subject, term_id: I.termA });
  }
  const approved = await request(app).post(`${base}/results/approve`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });
  expect(approved.status).toBe(200);
  const published = await request(app).post(`${base}/results/publish`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });
  expect(published.status).toBe(200);
  expect(published.body.data.notifications_queued).toBe(true);
}

type Row = { user_id: string; type: string; title: string; body: string; payload: Record<string, unknown> };
async function notificationsFor(userId: string): Promise<Row[]> {
  return (await owner.query<Row>(
    `SELECT user_id, type, title, body, payload FROM notifications WHERE user_id = $1 ORDER BY payload->>'student_id'`, [userId])).rows;
}

async function queue(schoolId: string, newValue: Record<string, unknown>) {
  await owner.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, new_value, ip_address)
     VALUES ($1, $2, 'PARENT_NOTIFICATION_QUEUED', 'result_status', $3, $4, NULL)`,
    [schoolId, I.principalA, I.jss2a, newValue]);
}

beforeEach(async () => {
  await seed();
  await setGradingScale(I.schoolA);
  // The seed leaves the tier null, which the plan check logs at error; a real school has one.
  await owner.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = ANY($1)`, [[I.schoolA, I.schoolB]]);
  const parent = (id: string, school: string, first: string) => owner.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, $3, 'x', 'parent', $4, 'Test', true, 'subject', false)`, [id, school, `${id}@test`, first]);
  await parent(SECOND_PARENT, I.schoolA, 'Second');
  await parent(PARENT_B, I.schoolB, 'ParentB');
  const link = (p: string, s: string) => owner.query(
    `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact) VALUES ($1, $2, 'father', false)`, [p, s]);
  await link(I.parentA, I.s2);      // parentA now has two children in JSS 2A: s1 (from the seed) and s2
  await link(SECOND_PARENT, I.s2);
  await link(PARENT_B, I.sOtherSchool);
  emailSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue('sent');
});

afterEach(() => emailSpy.mockRestore());
afterAll(async () => { await pool.end(); await owner.end(); });

describe('results published', () => {
  it('reaches every parent of every student in the class, once per child, naming the child', async () => {
    await publishClass();
    await processNotificationQueue();

    const a = await notificationsFor(I.parentA);
    expect(a.map(n => n.payload.student_id).sort()).toEqual([I.s1, I.s2].sort());
    for (const n of a) {
      expect(n.type).toBe('results_published');
      expect(n.title).toBe('Results published');
      expect(n.payload.term_id).toBe(I.termA);
    }
    expect(a.map(n => n.body).sort()).toEqual([
      "Student1's results for this term have been published. Sign in to view them.",
      "Student2's results for this term have been published. Sign in to view them.",
    ]);
    expect((await notificationsFor(SECOND_PARENT)).map(n => n.payload.student_id)).toEqual([I.s2]);

    // One email per notification, to the parent's own address.
    expect(emailSpy).toHaveBeenCalledTimes(3);
    expect(emailSpy.mock.calls.map(c => c[0]).sort()).toEqual([`${I.parentA}@test`, `${I.parentA}@test`, `${SECOND_PARENT}@test`].sort());

    const processed = await owner.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_logs WHERE action_type = 'PARENT_NOTIFICATION_QUEUED' AND processed_at IS NOT NULL`);
    expect(processed.rows[0].n).toBe(1);
  });

  it("never shows a parent the class list: the payload names only that parent's child", async () => {
    await publishClass();
    await processNotificationQueue();

    const rows = [...await notificationsFor(I.parentA), ...await notificationsFor(SECOND_PARENT)];
    expect(rows).toHaveLength(3);
    for (const n of rows) {
      expect(n.payload).not.toHaveProperty('student_ids');
      expect(n.payload).not.toHaveProperty('_support');
    }
  });

  it('a student named twice, or a parent linked twice, still gets one notice', async () => {
    await owner.query(
      `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact) VALUES ($1, $2, 'mother', false)`,
      [I.parentA, I.s1]);
    await queue(I.schoolA, { term_id: I.termA, notification_type: 'results_published', student_ids: [I.s1, I.s1], student_id: I.s1 });

    await processNotificationQueue();

    expect((await notificationsFor(I.parentA)).map(n => n.payload.student_id)).toEqual([I.s1]);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("a queue row never reaches another school's parent", async () => {
    // Control: the same row shape for this school's own student is delivered.
    await queue(I.schoolA, { term_id: I.termA, notification_type: 'results_published', student_ids: [I.s1] });
    await queue(I.schoolA, { term_id: I.termA, notification_type: 'results_published', student_ids: [I.sOtherSchool] });

    await processNotificationQueue();

    expect(await notificationsFor(I.parentA)).toHaveLength(1);
    expect(await notificationsFor(PARENT_B)).toHaveLength(0);
  });
});

describe('the single-student rows still deliver', () => {
  it('a behaviour row (student_id only) reaches that student’s parent', async () => {
    await queue(I.schoolA, { student_id: I.s1, notification_type: 'behaviour_incident', severity: 'minor', incident_type: 'Lateness' });

    await processNotificationQueue();

    const rows = await notificationsFor(I.parentA);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('behaviour_incident');
    expect(rows[0].payload.incident_type).toBe('Lateness');
    expect(rows[0].payload.student_id).toBe(I.s1);
  });
});
