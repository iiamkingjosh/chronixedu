/**
 * The notification queue write, and the claim the response makes about it.
 *
 * `audit_logs` rows with action_type PARENT_NOTIFICATION_QUEUED / TEACHER_NOTIFICATION_QUEUED
 * ARE the notification queue — the worker reads them. POST /results/publish used to write
 * that row fire-and-forget with `.catch(() => {})`, AFTER deciding its response, and answer
 * "Parent notifications have been queued" regardless. If the write failed, results were
 * published, the principal was told parents had been notified, no queue row existed, and
 * nothing anywhere recorded the failure. POST /results/return did the same for teachers.
 *
 * Found when the C-4a role-mode run deadlocked: the next test's seed TRUNCATE met that
 * INSERT still in flight after its request had returned — Postgres's deadlock report named
 * `INSERT INTO audit_logs` as the other process.
 *
 * The failure is forced with a trigger that rejects exactly the queue row, so these tests
 * fail on the old code deterministically — not by losing a timing race.
 */
import request from 'supertest';
import { Pool } from 'pg';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
// Trigger DDL is owner work; in role mode the shared pool is chronixedu_app.
const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

const fullMarks = () => [I.s1, I.s2].flatMap(student_id => [
  { student_id, component_id: I.ca1, score: 25 },
  { student_id, component_id: I.exam, score: 60 },
]);

async function submitAndApprove() {
  for (const [tok, subject] of [[tokens.math(), I.math], [tokens.english(), I.english]] as const) {
    await request(app).post(`${base}/scores/bulk-entry`).set('Authorization', tok)
      .send({ subject_id: subject, class_id: I.jss2a, term_id: I.termA, entries: fullMarks() });
    await request(app).post(`${base}/results/submit`).set('Authorization', tok)
      .send({ class_id: I.jss2a, subject_id: subject, term_id: I.termA });
  }
  const approved = await request(app).post(`${base}/results/approve`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA });
  expect(approved.status).toBe(200); // the precondition, asserted — not assumed
}

const publish = () => request(app).post(`${base}/results/publish`).set('Authorization', tokens.principalA())
  .send({ class_id: I.jss2a, term_id: I.termA });

async function queueRows(actionType: string): Promise<number> {
  return (await owner.query<{ n: number }>(
    `SELECT count(*)::int n FROM audit_logs WHERE school_id = $1 AND action_type = $2`, [I.schoolA, actionType])).rows[0].n;
}

/** Make the queue INSERT for one action type fail, as a DB error would. */
async function breakQueue(actionType: string) {
  await owner.query(`
    CREATE OR REPLACE FUNCTION test_break_notification_queue() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action_type = '${actionType}' THEN RAISE EXCEPTION 'simulated queue failure'; END IF;
      RETURN NEW;
    END $$`);
  await owner.query(`
    CREATE TRIGGER test_break_notification_queue BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION test_break_notification_queue()`);
}

beforeEach(seed);
afterEach(async () => {
  await owner.query(`DROP TRIGGER IF EXISTS test_break_notification_queue ON audit_logs`);
  await owner.query(`DROP FUNCTION IF EXISTS test_break_notification_queue()`);
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

describe('publishing results', () => {
  it('has written the parent queue row by the time it says so', async () => {
    await submitAndApprove();
    const res = await publish();
    expect(res.status).toBe(200);
    expect(res.body.data.notifications_queued).toBe(true);
    // Immediately — not "eventually". The old fire-and-forget write could still be in
    // flight here, which is how it came to deadlock with the next test's seed.
    expect(await queueRows('PARENT_NOTIFICATION_QUEUED')).toBe(1);
  });

  it('does NOT claim parents were notified when the queue write fails', async () => {
    await submitAndApprove();
    await breakQueue('PARENT_NOTIFICATION_QUEUED');

    const res = await publish();

    // The publish itself happened and is not undone — that is the honest state to report.
    expect(res.status).toBe(200);
    const published = await owner.query<{ n: number }>(
      `SELECT count(*)::int n FROM result_status WHERE term_id = $1 AND status = 'published'`, [I.termA]);
    expect(published.rows[0].n).toBe(2);

    expect(res.body.data.notifications_queued).toBe(false);
    expect(res.body.data.message).not.toMatch(/have been queued/i);
    expect(res.body.data.message).toMatch(/could not be queued/i);
    expect(await queueRows('PARENT_NOTIFICATION_QUEUED')).toBe(0);
  });
});

describe('returning results', () => {
  const returnResults = () => request(app).post(`${base}/results/return`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss2a, term_id: I.termA, reason: 'Math CA1 marks need rechecking' });

  it('has written the teacher queue row by the time it says so', async () => {
    await submitAndApprove();
    const res = await returnResults();
    expect(res.status).toBe(200);
    expect(res.body.data.notifications_queued).toBe(true);
    expect(await queueRows('TEACHER_NOTIFICATION_QUEUED')).toBe(1);
  });

  it('does NOT claim teachers were notified when the queue write fails', async () => {
    await submitAndApprove();
    await breakQueue('TEACHER_NOTIFICATION_QUEUED');

    const res = await returnResults();
    expect(res.status).toBe(200);
    expect(res.body.data.notifications_queued).toBe(false);
    expect(res.body.data.message).not.toMatch(/Teachers have been notified/i);
    expect(await queueRows('TEACHER_NOTIFICATION_QUEUED')).toBe(0);
  });
});
