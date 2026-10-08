/**
 * Class levels and deleting classes and subjects (audit, 8 Oct 2026).
 *
 * - `classes.level` is matched EXACTLY by grading overrides and assessment configs (CLAUDE.md), so
 *   "JSS" and "Jss" are two levels and a class typed with the second silently falls back to the
 *   school-wide settings. Nothing stopped the typo at the moment it was made.
 * - Changing a class's level moved it out from under the overrides and configs keyed to the old
 *   level, without a word.
 * - Deleting a class or subject checked two or three of the tables that use it. Any other use
 *   (attendance, homework, the timetable, fee lines, results) ended in a foreign-key error: 500.
 *
 * The last is held by a ratchet: every foreign key to classes or subjects must be in the list the
 * delete routes check, so a new table cannot bring the 500 back.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { CLASS_USES, SUBJECT_USES } from '../db/queries/roster';
import { updateAcademicConfig } from '../db/queries/schools';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const as = (tok: string) => ({
  post: (path: string, body: object) => request(app).post(`${base}${path}`).set('Authorization', tok).send(body),
  patch: (path: string, body: object) => request(app).patch(`${base}${path}`).set('Authorization', tok).send(body),
  del: (path: string) => request(app).delete(`${base}${path}`).set('Authorization', tok),
});
const principal = () => as(tokens.principalA());

beforeEach(async () => { await seed(); });
afterAll(() => pool.end());

describe('class levels', () => {
  it('a level is stored trimmed', async () => {
    const res = await principal().post('/classes', { name: 'JSS 1A', level: '  Junior  ' });
    expect(res.status).toBe(201);
    expect(res.body.data.level).toBe('Junior');
  });

  it('a level that differs from an existing one only in case or spacing is refused, naming the existing spelling', async () => {
    const res = await principal().post('/classes', { name: 'JSS 1A', level: 'junior' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LEVEL_NEAR_DUPLICATE');
    expect(res.body.error.message).toContain('"Junior"');
    expect((await pool.query(`SELECT 1 FROM classes WHERE name = 'JSS 1A'`)).rowCount).toBe(0);

    // The same check on an edit, and the exact spelling still goes through.
    expect((await principal().patch(`/classes/${I.jss3b}`, { name: 'SSS 1B', level: 'JUNIOR' })).status).toBe(409);
    expect((await principal().post('/classes', { name: 'JSS 1A', level: 'Junior' })).status).toBe(201);
  });

  it('changing a level that has its own settings warns, and names them', async () => {
    await updateAcademicConfig(I.schoolA, { level_overrides: { Senior: { promotion_cutoff: 50 } } });

    const res = await principal().patch(`/classes/${I.jss3b}`, { name: 'SSS 1B', level: 'Junior' });
    expect(res.status).toBe(200);
    expect(res.body.data.level).toBe('Junior');
    expect(res.body.warnings).toEqual([expect.stringContaining('Grading by Level has settings for "Senior"')]);

    // Control: a change of name alone warns about nothing.
    const quiet = await principal().patch(`/classes/${I.jss3b}`, { name: 'SSS 1 Blue', level: 'Junior' });
    expect(quiet.status).toBe(200);
    expect(quiet.body.warnings ?? []).toEqual([]);
  });
});

describe('deleting a class or subject still in use', () => {
  it('a class used only by the timetable is refused with 409, naming the use; an unused one is deleted', async () => {
    const spare = (await principal().post('/classes', { name: 'Spare', level: 'Junior' })).body.data.id;
    await pool.query(
      `INSERT INTO timetable_slots (school_id, class_id, term_id, day_of_week, period_number, subject_id, teacher_id)
       VALUES ($1, $2, $3, 1, 1, $4, $5)`, [I.schoolA, spare, I.termA, I.math, I.mathTeacher]);

    const refused = await principal().del(`/classes/${spare}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CLASS_IN_USE');
    expect(refused.body.error.message).toContain('the timetable');

    await pool.query(`DELETE FROM timetable_slots WHERE class_id = $1`, [spare]);
    expect((await principal().del(`/classes/${spare}`)).status).toBe(200);
  });

  it('a subject used only by homework is refused with 409, naming the use', async () => {
    const spare = (await principal().post('/subjects', { name: 'Music', code: 'MUS' })).body.data.id;
    await pool.query(
      `INSERT INTO assignments (school_id, class_id, subject_id, teacher_id, title, due_date)
       VALUES ($1, $2, $3, $4, 'Scales', '2026-10-20')`, [I.schoolA, I.jss2a, spare, I.mathTeacher]);

    const refused = await principal().del(`/subjects/${spare}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SUBJECT_IN_USE');
    expect(refused.body.error.message).toContain('homework');
  });

  it('every foreign key to classes and subjects is in the list the delete routes check', async () => {
    const fks = async (target: string) => (await pool.query<{ ref: string }>(
      `SELECT (c.conrelid::regclass)::text || '.' || a.attname AS ref
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = $1::regclass
        ORDER BY 1`, [target])).rows.map(r => r.ref);
    const listed = (uses: ReadonlyArray<{ table: string; column: string }>) => uses.map(u => `${u.table}.${u.column}`).sort();

    expect(listed(CLASS_USES)).toEqual(await fks('public.classes'));
    expect(listed(SUBJECT_USES)).toEqual(await fks('public.subjects'));
  });
});
