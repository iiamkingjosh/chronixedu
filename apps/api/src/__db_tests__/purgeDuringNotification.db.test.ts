/**
 * audit_logs is also the notification queue (*_NOTIFICATION_QUEUED rows the worker reads and
 * stamps processed_at on). Migration 036 broke that coupling once, silently. Migration 048 lets
 * a school's queue rows be deleted, so this proves — by doing it, not by reading the code — that
 * the worker survives its queue rows being purged in the middle of a run.
 *
 * The purge is triggered from INSIDE processNotificationQueue(): the mocked sendEmail runs the
 * full school deletion, which lands after the worker has read its batch and before it stamps the
 * row it is working on. School B's queued row is the control: it is processed after A's, so the
 * run demonstrably continued past the vanished row rather than stopping at it.
 */
import { Client } from 'pg';
import { seed, IDS as I, pool } from './helpers';
import { processNotificationQueue } from '../services/notificationWorker';
import { sendEmail } from '../services/emailService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { executeSchoolDeletion } = require('../../scripts/delete-school-data.js');

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn() }));
// SMS switched off (as in production since 1 Oct 2026): this test is about the purge, never a text.
jest.mock('../services/termiiService', () => ({
  ...jest.requireActual('../services/termiiService'),
  isSmsEnabled: jest.fn().mockReturnValue(false),
  sendTermiiSms: jest.fn().mockResolvedValue('disabled'),
}));

const OPERATOR = 'a1a1a1a1-0000-4000-8000-000000000001';

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'operator@chronix.test', 'x', 'super_admin', 'Op', 'Erator', true, false, false)`, [OPERATOR]);
});
afterAll(async () => { await pool.end(); });

it('the worker completes without throwing when the row it is working on is purged mid-run', async () => {
  const queue = (school: string, student: string, at: string) => pool.query(
    `INSERT INTO audit_logs (school_id, action_type, entity, entity_id, new_value, created_at)
     VALUES ($1, 'PARENT_NOTIFICATION_QUEUED', 'attendance', $2, $3::jsonb, $4)`,
    [school, student, JSON.stringify({ student_id: student, notification_type: 'low_attendance' }), at]);
  await queue(I.schoolA, I.s1, '2026-10-01T08:00:00Z');          // A first: has a linked parent, so sendEmail fires
  await queue(I.schoolB, I.sOtherSchool, '2026-10-01T08:01:00Z'); // B second: the control

  const owner = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await owner.connect();
  let purged = false;
  (sendEmail as jest.Mock).mockImplementation(async () => {
    // Suspended first, as the deletion requires (fix (a2)); here, not before the worker starts, so the
    // worker reads school A's queue exactly as it would have.
    if (!purged) {
      purged = true;
      await owner.query(`UPDATE schools SET is_active = false WHERE id = $1`, [I.schoolA]);
      await executeSchoolDeletion(owner, I.schoolA, OPERATOR);
    }
  });
  try {
    await expect(processNotificationQueue()).resolves.toBeUndefined();
  } finally {
    await owner.end();
  }

  expect(purged).toBe(true); // the purge really happened mid-run, inside the worker's loop
  expect((await pool.query(`SELECT 1 FROM schools WHERE id = $1`, [I.schoolA])).rowCount).toBe(0);
  expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE school_id = $1`, [I.schoolA])).rows[0].n).toBe(0);
  const b = await pool.query(`SELECT processed_at FROM audit_logs WHERE school_id = $1 AND action_type = 'PARENT_NOTIFICATION_QUEUED'`, [I.schoolB]);
  expect(b.rows).toHaveLength(1);
  expect(b.rows[0].processed_at).not.toBeNull(); // the run went on past the vanished row
});
