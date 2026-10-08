/**
 * Changes to a student are recorded (audit, 8 Oct 2026, S3; doctrine 10).
 *
 * Registering a student, editing their details, setting their photo, enrolling them in a session
 * and linking a parent wrote no audit row, so nothing could say who changed a child's record, or
 * what it said before. Each now does; an edit records the values it replaced, read under the same
 * lock as the write, so the second of two edits names the first's value.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    createUser: jest.fn(async () => ({ data: { user: { id: 'd2d2d2d2-0000-4000-8000-000000000001' } }, error: null })),
    getUserById: jest.fn(async () => ({ data: { user: null }, error: null })),
  } } },
}));

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const NEXT_SESSION = '10000000-0000-4000-8000-000000000091';

type AuditRow = { user_id: string; ip_address: string | null; entity_id: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> };
const audits = async (action: string): Promise<AuditRow[]> => (await pool.query<AuditRow>(
  `SELECT user_id, ip_address, entity_id, old_value, new_value FROM audit_logs WHERE action_type = $1 ORDER BY created_at`, [action])).rows;

beforeEach(async () => { await seed(); });
afterAll(() => pool.end());

it('a registration is recorded, with ids and counts and no contact details', async () => {
  const res = await request(app).post(`${base}/students`).set('Authorization', tokens.principalA()).set('X-Real-IP', '203.0.113.9')
    .send({ first_name: 'Ada', last_name: 'Bello', class_id: I.jss2a });
  expect(res.status).toBe(201);
  const [row] = await audits('STUDENT_REGISTERED');
  expect(row.user_id).toBe(I.principalA);
  expect(row.ip_address).toBe('203.0.113.9');
  expect(row.new_value).toEqual(expect.objectContaining({ class_id: I.jss2a, parents_linked: 0, parent_accounts_created: 0 }));
  expect(JSON.stringify(row.new_value)).not.toMatch(/Ada|Bello/);
});

it('an edit records what it replaced: the second of two edits names the first', async () => {
  const edit = (body: object) => request(app).patch(`${base}/students/${I.s1}`).set('Authorization', tokens.principalA()).send(body);
  expect((await edit({ address: '1 First Road', last_name: 'Okafor' })).status).toBe(200);
  expect((await edit({ address: '2 Second Road' })).status).toBe(200);

  const rows = await audits('STUDENT_UPDATED');
  expect(rows).toHaveLength(2);
  expect(rows[0].old_value).toEqual({ address: null, last_name: 'Test' });
  expect(rows[0].new_value).toEqual({ address: '1 First Road', last_name: 'Okafor' });
  expect(rows[1].old_value).toEqual({ address: '1 First Road' });
  expect(rows[1].new_value).toEqual({ address: '2 Second Road' });
});

it('linking an existing parent is recorded', async () => {
  const PARENT = '30000000-0000-4000-8000-000000000091';
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'link.me@example.test', 'x', 'parent', 'Link', 'Me', true, 'subject', false)`, [PARENT, I.schoolA]);
  const res = await request(app).post(`${base}/students/${I.s2}/parents`).set('Authorization', tokens.principalA())
    .send({ email: 'link.me@example.test', email_confirmation: 'link.me@example.test', first_name: 'Link', last_name: 'Me', relationship_type: 'mother' });
  expect(res.status).toBe(201);
  const [row] = await audits('PARENT_LINKED');
  expect(row.new_value).toEqual({ student_id: I.s2, parent_id: PARENT, relationship_type: 'mother', new_account: false });
});

it('enrolling a student in a session is recorded', async () => {
  await pool.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current) VALUES ($1, $2, '2027/2028', '2027-09-13', '2028-07-21', false)`,
    [NEXT_SESSION, I.schoolA]);
  const res = await request(app).post(`${base}/students/${I.s1}/promote`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss3b, session_id: NEXT_SESSION });
  expect(res.status).toBe(201);
  const [row] = await audits('STUDENT_PROMOTED');
  expect(row.new_value).toEqual({ student_id: I.s1, class_id: I.jss3b, session_id: NEXT_SESSION });
});
