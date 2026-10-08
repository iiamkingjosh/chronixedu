/**
 * Fee lines can be corrected, and invoices are never silently ₦0 (audit, 8 Oct 2026, F7).
 *
 * - A fee line could be added and never edited or deleted, so a typo stayed on every invoice until
 *   someone added a correcting line beside it. The same line could be added twice.
 * - Its amount was a JSON number (a float) and ₦0 was allowed; its term and class were not checked
 *   against the school.
 * - Generating invoices with no mandatory fee lines invoiced every student ₦0, "paid" in full; and
 *   generating was recorded nowhere.
 */
import request from 'supertest';
import { buildApp, seed, token, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const BURSAR = '30000000-0000-4000-8000-000000000061';
const bursar = () => token(BURSAR, 'bursar', I.schoolA);
const SECOND_TERM = '20000000-0000-4000-8000-000000000061';

const addLine = (body: object) => request(app).post(`${base}/fee-structures`).set('Authorization', bursar()).send(body);
const line = (over: object = {}) => ({ term_id: I.termA, class_id: I.jss2a, component_name: 'Tuition', amount: '50000.50', ...over });
const audits = async (action: string) => (await pool.query<{ old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null }>(
  `SELECT old_value, new_value FROM audit_logs WHERE action_type = $1 ORDER BY created_at`, [action])).rows;
// Sorted here, by lower-cased name: the database's collation is not the test's business.
const lines = async (termId = I.termA) => (await pool.query<{ component_name: string; amount: string; class_id: string | null }>(
  `SELECT component_name, amount::text, class_id FROM fee_structures WHERE term_id = $1`, [termId])).rows
  .sort((a, b) => a.component_name.toLowerCase().localeCompare(b.component_name.toLowerCase()));

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'bursar@test', 'x', 'bursar', 'Bee', 'Ursar', true, 'subject', false)`, [BURSAR, I.schoolA]);
  await pool.query(
    `INSERT INTO terms (id, session_id, school_id, name, start_date, end_date, is_current)
     VALUES ($1, $2, $3, 'Second Term', '2027-01-05', '2027-04-02', false)`, [SECOND_TERM, I.sessionA, I.schoolA]);
});
afterAll(() => pool.end());

describe('adding a fee line', () => {
  it('takes naira as text, exactly, and records it', async () => {
    const res = await addLine(line());
    expect(res.status).toBe(201);
    expect(await lines()).toEqual([{ component_name: 'Tuition', amount: '50000.50', class_id: I.jss2a }]);
    expect(await audits('FEE_STRUCTURE_CREATED')).toHaveLength(1);
  });

  it('refuses ₦0, a third decimal place, a float number, and another school’s term or class', async () => {
    for (const amount of ['0', '0.00', '10.123', '1e3', 1500]) {
      expect({ amount, status: (await addLine(line({ amount }))).status }).toEqual({ amount, status: 400 });
    }
    expect((await addLine(line({ term_id: I.termB }))).status).toBe(404);
    const classB = (await pool.query<{ id: string }>(`INSERT INTO classes (school_id, name, level) VALUES ($1, 'B1', 'Junior') RETURNING id`, [I.schoolB])).rows[0].id;
    expect((await addLine(line({ class_id: classB }))).status).toBe(404);
    expect(await lines()).toEqual([]);
  });

  it('refuses the same line twice for the same term and class, whatever its case or spacing', async () => {
    expect((await addLine(line())).status).toBe(201);
    const again = await addLine(line({ component_name: '  tuition ', amount: '1000' }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_FEE_LINE');
    // The same name for another class, or for the whole school, is a different line.
    expect((await addLine(line({ class_id: I.jss3b }))).status).toBe(201);
    expect((await addLine(line({ class_id: null }))).status).toBe(201);
  });
});

describe('correcting a fee line', () => {
  it('edits are recorded with what they replaced: the second names the first', async () => {
    const id = (await addLine(line())).body.data.id;
    const edit = (body: object) => request(app).patch(`${base}/fee-structures/${id}`).set('Authorization', bursar()).send(body);
    expect((await edit({ amount: '45000' })).status).toBe(200);
    expect((await edit({ amount: '46000', component_name: 'School fees' })).status).toBe(200);
    expect(await lines()).toEqual([{ component_name: 'School fees', amount: '46000.00', class_id: I.jss2a }]);
    const rows = await audits('FEE_STRUCTURE_UPDATED');
    expect(rows.map(r => r.old_value?.amount)).toEqual(['50000.50', '45000.00']);
    expect(rows.map(r => r.new_value?.amount)).toEqual(['45000.00', '46000.00']);
  });

  it('a deleted line is gone and recorded with what it was; an edit into a duplicate is refused', async () => {
    const a = (await addLine(line())).body.data.id;
    const b = (await addLine(line({ component_name: 'Books', amount: '5000' }))).body.data.id;
    const clash = await request(app).patch(`${base}/fee-structures/${b}`).set('Authorization', bursar()).send({ component_name: 'TUITION' });
    expect(clash.status).toBe(409);

    expect((await request(app).delete(`${base}/fee-structures/${a}`).set('Authorization', bursar())).status).toBe(200);
    expect((await lines()).map(l => l.component_name)).toEqual(['Books']);
    const [row] = await audits('FEE_STRUCTURE_DELETED');
    expect(row.old_value).toMatchObject({ component_name: 'Tuition', amount: '50000.50' });
  });
});

describe('generating invoices', () => {
  const generate = () => request(app).post(`${base}/fee-invoices/generate`).set('Authorization', bursar())
    .send({ term_id: I.termA, class_id: I.jss2a });

  it('with no mandatory fee lines is refused, and makes no ₦0 invoices', async () => {
    await addLine(line({ is_mandatory: false, component_name: 'Excursion' }));
    const res = await generate();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_FEE_LINES');
    expect((await pool.query(`SELECT 1 FROM fee_invoices`)).rowCount).toBe(0);
  });

  it('invoices each student the sum of the mandatory lines, worked out in the database, and records it', async () => {
    await addLine(line({ amount: '50000.50' }));
    await addLine(line({ component_name: 'Books', amount: '9.59', class_id: null }));
    await addLine(line({ component_name: 'Excursion', amount: '7000', is_mandatory: false }));
    const res = await generate();
    expect(res.status).toBe(200);
    const totals = (await pool.query<{ total: string }>(`SELECT total_amount::text AS total FROM fee_invoices ORDER BY student_id`)).rows;
    expect(totals).toEqual([{ total: '50010.09' }, { total: '50010.09' }]);
    const [row] = await audits('FEE_INVOICES_GENERATED');
    expect(row.new_value).toEqual({ term_id: I.termA, class_id: I.jss2a, invoices: 2, total_kobo: 5001009 });
  });
});

describe('copying fee lines into a new term', () => {
  it('copies every line, skipping any the new term already has, and records it', async () => {
    await addLine(line());
    await addLine(line({ component_name: 'Books', amount: '5000', class_id: null }));
    await addLine(line({ term_id: SECOND_TERM, component_name: 'books', amount: '6000', class_id: null }));

    const res = await request(app).post(`${base}/fee-structures/copy-from-term`).set('Authorization', bursar())
      .send({ from_term_id: I.termA, to_term_id: SECOND_TERM });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ copied: 1, skipped: 1 });
    expect(await lines(SECOND_TERM)).toEqual([
      { component_name: 'books', amount: '6000.00', class_id: null },
      { component_name: 'Tuition', amount: '50000.50', class_id: I.jss2a },
    ]);
    expect(await audits('FEE_STRUCTURES_COPIED')).toHaveLength(1);
  });
});
