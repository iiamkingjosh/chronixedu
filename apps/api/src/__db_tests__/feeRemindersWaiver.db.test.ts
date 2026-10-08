/**
 * Fee reminders and waivers (audit, 8 Oct 2026).
 *
 * - "Send Fee Reminders" messaged every parent with a balance, as often as anyone clicked, and the
 *   run was recorded nowhere. A manual run is now recorded, and a second within the hour is refused
 *   with how long to wait. The check and the record are made together in the database, so they
 *   hold with Redis down.
 * - A waiver moves no money, and could be recorded with no reason, so nothing said why a balance
 *   went away. It now needs one.
 */
import request from 'supertest';
import { buildApp, seed, token, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const BURSAR = '30000000-0000-4000-8000-000000000062';
const bursar = () => token(BURSAR, 'bursar', I.schoolA);
const runs = async () => (await pool.query(`SELECT user_id FROM audit_logs WHERE action_type = 'FEE_REMINDERS_RUN'`)).rows;

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'bursar2@test', 'x', 'bursar', 'Bee', 'Two', true, 'subject', false)`, [BURSAR, I.schoolA]);
  // The seed leaves the tier null, which the plan check logs at error; a real school has one.
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
});
afterAll(() => pool.end());

describe('sending fee reminders by hand', () => {
  const run = () => request(app).post(`${base}/fee-reminders/run`).set('Authorization', bursar());

  it('is recorded, and a second run within the hour is refused with how long to wait', async () => {
    const first = await run();
    expect(first.status).toBe(200);
    expect(await runs()).toEqual([{ user_id: BURSAR }]);

    const second = await run();
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('REMINDERS_RECENTLY_SENT');
    expect(second.body.error.retry_after_seconds).toBeGreaterThan(3500);
    expect(await runs()).toHaveLength(1);
  });

  // Earlier runs are inserted with their time, never aged by UPDATE: audit rows are append-only.
  const earlierRun = (minutes: number) => pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, new_value, ip_address, created_at)
     VALUES ($1, $2, 'FEE_REMINDERS_RUN', 'fee_invoices', '{}'::jsonb, NULL, NOW() - make_interval(mins => $3))`,
    [I.schoolA, BURSAR, minutes]);

  it('a run 61 minutes ago does not hold this one back', async () => {
    await earlierRun(61);
    expect((await run()).status).toBe(200);
  });

  it('a run 59 minutes ago does', async () => {
    await earlierRun(59);
    expect((await run()).status).toBe(429);
  });

  it("another school's run does not hold this one back", async () => {
    await pool.query(
      `INSERT INTO audit_logs (school_id, user_id, action_type, entity, new_value, ip_address)
       VALUES ($1, $2, 'FEE_REMINDERS_RUN', 'fee_invoices', '{}'::jsonb, NULL)`, [I.schoolB, I.principalB]);
    expect((await run()).status).toBe(200);
  });
});

describe('a waiver', () => {
  it('needs a reason', async () => {
    const invoice = (await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`, [I.schoolA, I.s1, I.termA])).rows[0].id;
    const pay = (body: object) => request(app).post(`${base}/payments`).set('Authorization', bursar())
      .send({ invoice_id: invoice, amount: '10000', method: 'waiver', ...body });

    const refused = await pay({});
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body.error)).toMatch(/reason for the waiver/);

    const given = await pay({ reference: 'Staff child' });
    expect(given.status).toBe(201);
    const [row] = (await pool.query(`SELECT method, reference FROM payments WHERE invoice_id = $1`, [invoice])).rows;
    expect(row).toEqual({ method: 'waiver', reference: 'Staff child' });
  });
});
