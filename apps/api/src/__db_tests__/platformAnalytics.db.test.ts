/**
 * Platform analytics must count customers, not rows.
 *
 * GET /analytics/overview ran `SELECT COUNT(*) FROM schools` and
 * `SELECT COUNT(*) FROM students` with no state filter at all, so 44 fixture schools
 * left behind by integration tests were reported as platform scale — the figure quoted
 * to an investor or a prospective school. These are the numbers that matter most at the
 * moment they are least likely to be checked.
 *
 * Filtering on is_active would not have fixed it: total_schools would have become
 * identical to active_schools, and suspended real customers would have silently dropped
 * out of platform totals. Migration 035 adds is_demo for "not a customer", orthogonal
 * to is_active's "access currently enabled".
 *
 * Also covers migration 036: doctrine 6 says audit_logs has no DELETE, which was true
 * of the RLS policies and false of the database — the API's pool connects as the table
 * owner and bypasses RLS.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { seed, IDS as I, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRoutes);
app.use(errorHandler);

const SUPER = 'c0000000-0000-4000-8000-000000000001';
const superToken = () =>
  'Bearer ' + jwt.sign(
    { user_id: SUPER, school_id: null, role: 'super_admin', email: 'root@test' },
    process.env.JWT_SECRET!
  );

beforeEach(seed);
afterAll(() => pool.end());

/** School B becomes a fixture tenant; School A stays a real customer. */
async function markBAsDemo(): Promise<void> {
  await pool.query(`UPDATE schools SET is_demo = true WHERE id = $1`, [I.schoolB]);
}

async function overview(): Promise<Record<string, number>> {
  const res = await request(app)
    .get('/api/super-admin/analytics/overview')
    .set('Authorization', superToken());
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('platform analytics exclude non-customer schools', () => {
  it('counts both schools while neither is marked demo', async () => {
    const d = await overview();
    expect(d.total_schools).toBe(2);
    expect(d.active_schools).toBe(2);
  });

  it('drops a demo school from total_schools and active_schools', async () => {
    await markBAsDemo();
    const d = await overview();
    expect(d.total_schools).toBe(1);
    expect(d.active_schools).toBe(1);
  });

  it('drops a demo school\'s students from total_students', async () => {
    const before = (await overview()).total_students;
    expect(before).toBeGreaterThan(0);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) n FROM students WHERE school_id = $1`, [I.schoolB]);
    const bStudents = Number(rows[0].n);
    expect(bStudents).toBeGreaterThan(0);

    await markBAsDemo();
    expect((await overview()).total_students).toBe(before - bStudents);
  });

  it('keeps a SUSPENDED real school in total_schools but out of active_schools', async () => {
    // The distinction is the whole reason is_demo exists rather than reusing is_active.
    // A suspended school is still a customer and still platform scale.
    await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [I.schoolB]);
    const d = await overview();
    expect(d.total_schools).toBe(2);
    expect(d.active_schools).toBe(1);
  });

  it('excludes a demo school from new_schools_this_month', async () => {
    await pool.query(`UPDATE schools SET created_at = NOW() WHERE id IN ($1, $2)`, [I.schoolA, I.schoolB]);
    expect((await overview()).new_schools_this_month).toBe(2);
    await markBAsDemo();
    expect((await overview()).new_schools_this_month).toBe(1);
  });

  it('hides demo schools from the platform school list unless asked for', async () => {
    await markBAsDemo();
    const hidden = await request(app).get('/api/super-admin/schools').set('Authorization', superToken());
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.schools.map((s: { name: string }) => s.name)).toEqual(['School A']);

    const shown = await request(app)
      .get('/api/super-admin/schools?include_demo=true')
      .set('Authorization', superToken());
    expect(shown.body.data.schools.map((s: { name: string }) => s.name).sort()).toEqual(['School A', 'School B']);
  });
});

describe('audit_logs is append-only in the database, not just in the docs', () => {
  async function anAuditRow(): Promise<void> {
    await pool.query(
      `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id)
       VALUES ($1, $2, 'TEST_ACTION', 'test', $2)`,
      [I.schoolA, I.principalA]
    );
  }

  it('accepts inserts', async () => {
    await anAuditRow();
    const { rows } = await pool.query(`SELECT 1 FROM audit_logs WHERE action_type = 'TEST_ACTION'`);
    expect(rows).toHaveLength(1);
  });

  it('rejects DELETE even as the table owner, which bypasses RLS', async () => {
    await anAuditRow();
    await expect(
      pool.query(`DELETE FROM audit_logs WHERE action_type = 'TEST_ACTION'`)
    ).rejects.toThrow(/append-only/);
    const { rows } = await pool.query(`SELECT 1 FROM audit_logs WHERE action_type = 'TEST_ACTION'`);
    expect(rows).toHaveLength(1);
  });

  it('rejects a DELETE that matches no rows, so the rule cannot be probed', async () => {
    await expect(
      pool.query(`DELETE FROM audit_logs WHERE action_type = 'NOTHING_MATCHES_THIS'`)
    ).rejects.toThrow(/append-only/);
  });

  it('rejects an UPDATE that rewrites the record — that is what append-only means', async () => {
    await anAuditRow();
    await expect(
      pool.query(`UPDATE audit_logs SET action_type = 'TAMPERED' WHERE action_type = 'TEST_ACTION'`)
    ).rejects.toThrow(/append-only/);
  });

  it('allows processed_at to be stamped — audit_logs is also the notification queue', async () => {
    // Migration 036 banned every UPDATE, which broke notificationWorker.ts:115 and
    // silenced notifications: the worker logs the failure and moves on, so it would
    // have been a green deploy with no parent notifications. 037 narrowed it.
    await anAuditRow();
    await expect(
      pool.query(`UPDATE audit_logs SET processed_at = NOW() WHERE action_type = 'TEST_ACTION'`)
    ).resolves.toBeDefined();
    const { rows } = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM audit_logs WHERE action_type = 'TEST_ACTION'`);
    expect(rows[0].processed_at).not.toBeNull();
  });

  it('still rejects a change that smuggles a content edit alongside processed_at', async () => {
    await anAuditRow();
    await expect(
      pool.query(`UPDATE audit_logs SET processed_at = NOW(), entity = 'tampered' WHERE action_type = 'TEST_ACTION'`)
    ).rejects.toThrow(/append-only/);
  });
});
