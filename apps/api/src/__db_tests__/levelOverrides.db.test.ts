/**
 * The per-level grading screen's contract with the API.
 *
 * `level_overrides` has existed in the resolver and the report card for weeks with no way
 * to set it from the product. The screen that fixes that stands on four properties, each
 * tested here because each fails silently if it breaks:
 *
 *   1. A save persists — even for a school with no school_settings row, where the old
 *      `UPDATE … WHERE school_id` matched nothing and still answered "updated".
 *   2. The level list is the set real classes carry, because levels are matched exactly
 *      and an override on a level no class has does nothing.
 *   3. `level_overrides` is replaced wholesale on save, and nothing else is — so the
 *      screen's read-modify-write is the only thing that can drop an override.
 *   4. "Same as school-wide" and "set to the same number" are different (doctrine 8): an
 *      explicit override stays pinned when the school-wide value later moves.
 */
import request from 'supertest';
import { seed, IDS as I, tokens, buildApp, pool } from './helpers';
import { getStudentsAtRisk } from '../services/resultEngine';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

beforeEach(seed);
afterAll(async () => {
  await pool.end();
});

const levels = (tok = tokens.principalA()) =>
  request(app).get(`${base}/academic-config/levels`).set('Authorization', tok);
const patch = (body: object) =>
  request(app).patch(`${base}/academic-config`).set('Authorization', tokens.principalA()).send(body);

async function settingsRows(): Promise<number> {
  return (await pool.query(`SELECT count(*)::int n FROM school_settings WHERE school_id = $1`, [I.schoolA])).rows[0].n;
}

describe('saving', () => {
  it('persists for a school that has no school_settings row — the old UPDATE silently did nothing', async () => {
    // The seed creates no settings row, which is exactly the state that made the old
    // `UPDATE ... WHERE school_id = $2` match zero rows while the route said "updated".
    expect(await settingsRows()).toBe(0);

    const res = await patch({ level_overrides: { Senior: { promotion_cutoff: 90 } } });
    expect(res.status).toBe(200);

    expect(await settingsRows()).toBe(1);
    expect((await levels()).body.data.level_overrides).toEqual({ Senior: { promotion_cutoff: 90 } });
  });

  it('replaces level_overrides wholesale and leaves the school-wide values alone', async () => {
    await patch({ promotion_cutoff: 45 });
    await patch({ level_overrides: { Junior: { promotion_cutoff: 50 }, Senior: { promotion_cutoff: 60 } } });
    // Dropping Junior is done by sending the map without it — that is the screen's model.
    await patch({ level_overrides: { Senior: { promotion_cutoff: 60 } } });

    const { data } = (await levels()).body;
    expect(data.level_overrides).toEqual({ Senior: { promotion_cutoff: 60 } });
    expect(data.school_wide.promotion_cutoff).toBe(45); // untouched by an overrides-only save
  });

  it('clears every override with an empty map', async () => {
    await patch({ level_overrides: { Senior: { promotion_cutoff: 60 } } });
    // Asserted before clearing: a save that silently did nothing ALSO ends at {}, so
    // without this line the test passed against the broken UPDATE. It did.
    expect((await levels()).body.data.level_overrides).toEqual({ Senior: { promotion_cutoff: 60 } });
    await patch({ level_overrides: {} });
    expect((await levels()).body.data.level_overrides).toEqual({});
  });

  it('rejects an override with invalid bands and names the level', async () => {
    const res = await patch({
      level_overrides: {
        Senior: { grading_scale: [{ grade: 'A', min: 50, max: 100, label: 'A', remark: '' }] }, // no band reaches 0
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_GRADE_BANDS');
    expect(res.body.error.message).toContain('Senior');
  });
});

describe('what the screen is offered', () => {
  it('lists the levels real classes carry, with the classes under each', async () => {
    const { data } = (await levels()).body;
    expect(data.levels).toEqual([
      { level: 'Junior', class_names: ['JSS 2A'] },
      { level: 'Senior', class_names: ['SSS 1B'] },
    ]);
  });

  it('reports "no school-wide pass mark" as null, not as a number it made up', async () => {
    expect((await levels()).body.data.school_wide.promotion_cutoff).toBeNull();
  });

  it('flags an override whose level no class has — config that looks like a decision and does nothing', async () => {
    await patch({ level_overrides: { Jss: { promotion_cutoff: 70 }, Senior: { promotion_cutoff: 60 } } });
    expect((await levels()).body.data.orphaned_overrides).toEqual(['Jss']);
  });

  it('flags levels that differ only by case or spaces, which the resolver treats as different', async () => {
    await pool.query(`INSERT INTO classes (school_id, name, level) VALUES ($1, 'JSS 2C', 'junior ')`, [I.schoolA]);
    // Code-point order, set by the API — not the database's collation.
    expect((await levels()).body.data.near_duplicate_levels).toEqual([['Junior', 'junior ']]);
  });

  it('is sent uncached — a stale read followed by a wholesale save would restore old overrides', async () => {
    expect((await levels()).headers['cache-control']).toBe('no-store');
  });
});

describe('who can see it', () => {
  it('refuses a teacher — the same people the save refuses', async () => {
    expect((await levels(tokens.math())).status).toBe(403);
  });

  it('refuses another school’s principal', async () => {
    expect((await levels(tokens.principalB())).status).toBe(403);
  });
});

describe('"same as school-wide" is not "the same number" (doctrine 8)', () => {
  it('keeps an explicit override pinned when the school-wide pass mark later moves', async () => {
    // Senior pinned at 40, which is ALSO the school-wide value when it is set. Then the
    // school raises its pass mark to 50. A screen that treated "equal to school-wide" as
    // "not overridden" would have saved nothing for Senior and let it follow to 50.
    await patch({ promotion_cutoff: 40, level_overrides: { Senior: { promotion_cutoff: 40 } } });
    await patch({ promotion_cutoff: 50 });

    // A Senior student at 45%: at risk under 50, safe under the pinned 40.
    await pool.query(
      `INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1,$2,$3,$4,$5)`,
      [I.mathTeacher, I.jss3b, I.math, I.termA, I.schoolA]
    );
    await pool.query(
      `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score)
       VALUES ($1,$2,$3,$4,$5,40), ($1,$2,$3,$4,$6,30)`, // 40/50×30 + 30/100×70 = 24 + 21 = 45
      [I.schoolA, I.s3OtherClass, I.math, I.termA, I.ca1, I.exam]
    );

    const atRisk = await getStudentsAtRisk(I.termA, I.schoolA);
    expect(atRisk.find(s => s.student_id === I.s3OtherClass)).toBeUndefined();
    expect((await levels()).body.data.level_overrides).toEqual({ Senior: { promotion_cutoff: 40 } });
  });
});
