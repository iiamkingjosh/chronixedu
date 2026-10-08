/**
 * The principal's setup checklist (audit, 8 Oct 2026).
 *
 * A new school has no grading scale, pass mark or assessment structure until the principal sets
 * them (doctrine 8), and nothing told the principal so: each gap surfaced later, as a refusal in
 * someone else's hands (a teacher's empty score sheet, a publish refused). The checklist names
 * every gap and the page that fills it.
 *
 * School A of the seed is set up except for grading, pass mark, fees and payout; School B has
 * only its calendar. Each case shows items done as well as missing, so neither "all missing" nor
 * "all done" can pass by a checklist that always says the same thing.
 */
import request from 'supertest';
import { buildApp, seed, setGradingScale, tokens, IDS as I, pool } from './helpers';
import { getSetupStatus } from '../services/setupStatus';
import { updateAcademicConfig } from '../db/queries/schools';

const app = buildApp();
const TODAY = '2026-10-08'; // inside both seed terms

const byKey = (items: Awaited<ReturnType<typeof getSetupStatus>>) => Object.fromEntries(items.map(i => [i.key, i]));

beforeEach(async () => { await seed(); });
afterAll(() => pool.end());

it('a school with only its calendar is told everything else is missing, each with its page', async () => {
  const items = byKey(await getSetupStatus(I.schoolB, TODAY));
  expect(items.current_term.done).toBe(true);
  for (const key of ['grading_scale', 'pass_mark', 'assessment', 'classes', 'subjects', 'teachers', 'teacher_assignments', 'students_in_classes', 'fee_lines', 'payout']) {
    expect({ key, done: items[key]?.done }).toEqual({ key, done: false });
    expect(items[key].href).toMatch(/^\/(settings|bursar|registrar)\//);
    expect(items[key].detail.length).toBeGreaterThan(0);
  }
});

it('a school set up in full has every item done', async () => {
  // School A's gaps, filled the way the product fills them.
  await setGradingScale(I.schoolA);
  await updateAcademicConfig(I.schoolA, { promotion_cutoff: 50 });
  await pool.query(
    `INSERT INTO fee_structures (school_id, class_id, term_id, component_name, amount) VALUES ($1, $2, $3, 'Tuition', 50000)`,
    [I.schoolA, I.jss2a, I.termA]);
  await pool.query(`UPDATE schools SET payout_config = '{"settlement_status": "active"}'::jsonb WHERE id = $1`, [I.schoolA]);

  const items = await getSetupStatus(I.schoolA, TODAY);
  expect(items.filter(i => !i.done)).toEqual([]);
  expect(items.length).toBe(11);
});

it('names the gaps of a partly set-up school, and only those', async () => {
  const missing = (await getSetupStatus(I.schoolA, TODAY)).filter(i => !i.done).map(i => i.key).sort();
  expect(missing).toEqual(['fee_lines', 'grading_scale', 'pass_mark', 'payout']);
});

it('a term that has ended says so, and that the next one needs activating', async () => {
  const items = byKey(await getSetupStatus(I.schoolA, '2027-01-10'));
  expect(items.current_term.done).toBe(false);
  expect(items.current_term.detail).toMatch(/First Term ended on 18 Dec 2026/);
  expect(items.current_term.href).toBe('/settings/academic-structure');
});

it('is served to the principal, and to no one else', async () => {
  const ok = await request(app).get(`/api/schools/${I.schoolA}/setup-status`).set('Authorization', tokens.principalA());
  expect(ok.status).toBe(200);
  expect(ok.body.data.items.length).toBe(11);

  const teacher = await request(app).get(`/api/schools/${I.schoolA}/setup-status`).set('Authorization', tokens.math());
  expect(teacher.status).toBe(403);
  const otherSchool = await request(app).get(`/api/schools/${I.schoolA}/setup-status`).set('Authorization', tokens.principalB());
  expect(otherSchool.status).toBe(403);
});
