/**
 * A report card's promotion line follows the term's place in its session, not its name
 * (audit, 8 Oct 2026). `computePromotionStatus` compared the term's NAME with "third term", so a
 * school whose terms were called "1st Term", "Term 2", "3rd Term" never had a promotion decision
 * printed. The report data now carries the term's position by start date, and the third decides.
 */
import { seed, IDS as I, pool } from './helpers';
import { fetchStudentReportData } from '../db/queries/reportCards';
import { computePromotionStatus } from '../services/reportCardService';

let term2: string;
let term3: string;

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE terms SET name = '1st Term' WHERE id = $1`, [I.termA]);
  // Inserted out of order, so position comes from the dates and not from insertion.
  term3 = (await pool.query<{ id: string }>(
    `INSERT INTO terms (session_id, school_id, name, start_date, end_date) VALUES ($1, $2, 'Term Three', '2027-04-20', '2027-07-20') RETURNING id`,
    [I.sessionA, I.schoolA])).rows[0].id;
  term2 = (await pool.query<{ id: string }>(
    `INSERT INTO terms (session_id, school_id, name, start_date, end_date) VALUES ($1, $2, 'Term 2', '2027-01-05', '2027-04-02') RETURNING id`,
    [I.sessionA, I.schoolA])).rows[0].id;
});

afterAll(() => pool.end());

it("each term's position in its session comes from its dates", async () => {
  expect((await fetchStudentReportData(I.s1, I.termA, I.schoolA))?.term_position).toBe(1);
  expect((await fetchStudentReportData(I.s1, term2, I.schoolA))?.term_position).toBe(2);
  expect((await fetchStudentReportData(I.s1, term3, I.schoolA))?.term_position).toBe(3);
});

it('the third term decides promotion whatever it is called; the others do not', async () => {
  const third = await fetchStudentReportData(I.s1, term3, I.schoolA);
  expect(computePromotionStatus(third!.term_position, 5, 65, 50).promotionStatus).toBe('Promoted');
  expect(computePromotionStatus(third!.term_position, 5, 35, 50).promotionStatus).toBe('Repeat Class');

  const first = await fetchStudentReportData(I.s1, I.termA, I.schoolA);
  expect(computePromotionStatus(first!.term_position, 5, 35, 50).promotionStatus).toBe('Term Completed');
});
