/**
 * users.support_code is assigned from codes nobody holds (migration 050).
 *
 * Migration 025 made it a random six-digit DEFAULT on a UNIQUE column with no retry, so any user
 * insert could draw a code already in use and fail. That is how CI run 189 failed on 1 Oct 2026:
 * `duplicate key value violates unique constraint "users_support_code_key"` while the shared seed
 * inserted a student, in a suite the commit under test never touched. In production it is the
 * birthday problem growing with every school.
 *
 * The collision is forced, not hoped for: setseed() makes random() repeatable on one connection,
 * so a test can learn the code the generator will draw next, give it to someone, rewind, and insert.
 * Before 050 that insert fails with the duplicate key every time; after it, it gets another code.
 */
import type { PoolClient } from 'pg';
import { seed, IDS as I, pool } from './helpers';

beforeEach(seed);
afterAll(() => pool.end());

const id = (n: number) => `5c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function nextDraw(c: PoolClient, s: number): Promise<string> {
  await c.query('SELECT setseed($1)', [s]);
  const { rows } = await c.query<{ code: string }>('SELECT (floor(random() * 900000 + 100000))::text AS code');
  await c.query('SELECT setseed($1)', [s]); // rewind: the next random() repeats that draw
  return rows[0].code;
}

const insertSql = `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password`;

describe('support codes', () => {
  it('every new user gets a six-digit code no other user holds (the control)', async () => {
    const codes: string[] = [];
    for (let n = 1; n <= 40; n++) {
      const { rows } = await pool.query<{ support_code: string }>(
        `${insertSql}) VALUES ($1, $2, $3, 'x', 'teacher', 'T', 'Test', true, 'subject', false) RETURNING support_code`,
        [id(n), I.schoolA, `code-${n}@test`]);
      codes.push(rows[0].support_code);
    }
    expect(codes.every(c => /^\d{6}$/.test(c))).toBe(true);
    const all = (await pool.query<{ n: number; d: number }>('SELECT count(*)::int n, count(DISTINCT support_code)::int d FROM users')).rows[0];
    expect(all.n).toBeGreaterThan(40); // the seed's users are in the comparison too
    expect(all.d).toBe(all.n);
  });

  it('a code already taken is never assigned: a forced collision gets another code', async () => {
    const c = await pool.connect();
    try {
      const taken = await nextDraw(c, 0.42);
      await c.query(`${insertSql}, support_code) VALUES ($1, $2, 'holder@test', 'x', 'teacher', 'H', 'Older', true, 'subject', false, $3)`,
        [id(100), I.schoolA, taken]);
      await c.query('SELECT setseed($1)', [0.42]); // the generator's next draw is `taken` again

      const { rows } = await c.query<{ support_code: string }>(
        `${insertSql}) VALUES ($1, $2, 'newcomer@test', 'x', 'teacher', 'N', 'Ewer', true, 'subject', false) RETURNING support_code`,
        [id(101), I.schoolA]);
      expect(rows[0].support_code).not.toBe(taken);
      expect(rows[0].support_code).toMatch(/^\d{6}$/);
    } finally {
      c.release();
    }
  });

  it('a multi-row insert cannot collide with itself', async () => {
    const c = await pool.connect();
    try {
      const taken = await nextDraw(c, 0.77);
      // One statement: the first row takes the code explicitly, the second asks for one, and the
      // generator's first draw for it is that same code.
      const { rows } = await c.query<{ id: string; support_code: string }>(
        `${insertSql}, support_code) VALUES
           ($1, $3, 'first@test', 'x', 'teacher', 'F', 'Irst', true, 'subject', false, $4),
           ($2, $3, 'second@test', 'x', 'teacher', 'S', 'Econd', true, 'subject', false, DEFAULT)
         RETURNING id, support_code`,
        [id(200), id(201), I.schoolA, taken]);
      const second = rows.find(r => r.id === id(201))!;
      expect(second.support_code).not.toBe(taken);
      expect(second.support_code).toMatch(/^\d{6}$/);
    } finally {
      c.release();
    }
  });

  /** The generator's next n draws for seed s, in order: one random() per call, as the trigger draws. */
  async function nextDraws(c: PoolClient, s: number, n: number): Promise<string[]> {
    await c.query('SELECT setseed($1)', [s]);
    const draws: string[] = [];
    for (let i = 0; i < n; i++) {
      draws.push((await c.query<{ code: string }>('SELECT (floor(random() * 900000 + 100000))::text AS code')).rows[0].code);
    }
    return draws;
  }
  /** Give each code to a user (explicit codes draw nothing, so the sequence is untouched). */
  async function hold(c: PoolClient, codes: string[], base: number): Promise<void> {
    const distinct = [...new Set(codes)];
    for (let i = 0; i < distinct.length; i++) {
      await c.query(`${insertSql}, support_code) VALUES ($1, $2, $3, 'x', 'teacher', 'H', 'Older', true, 'subject', false, $4)`,
        [id(base + i), I.schoolA, `holder-${base + i}@test`, distinct[i]]);
    }
  }
  const newcomer = (c: PoolClient, n: number) => c.query<{ support_code: string }>(
    `${insertSql}) VALUES ($1, $2, $3, 'x', 'teacher', 'N', 'Ewer', true, 'subject', false) RETURNING support_code`,
    [id(n), I.schoolA, `newcomer-${n}@test`]);

  it('stops after 100 draws with a named error (SC001) instead of looping on (migration 051)', async () => {
    const c = await pool.connect();
    try {
      const draws = await nextDraws(c, 0.13, 100);
      await hold(c, draws, 1000); // every one of the trigger's next 100 draws is taken
      await c.query('SELECT setseed($1)', [0.13]);
      // Before 051 the loop drew a 101st code and the insert succeeded; it could, in principle, never stop.
      await expect(newcomer(c, 1999)).rejects.toMatchObject({
        code: 'SC001',
        message: expect.stringContaining('no unused six-digit code in 100 random draws'),
      });
    } finally {
      c.release();
    }
  });

  it('...and the 100th draw is still allowed (the control: the bound is 100, and the replay lines up)', async () => {
    const c = await pool.connect();
    try {
      const draws = await nextDraws(c, 0.29, 100);
      expect(draws.slice(0, 99)).not.toContain(draws[99]); // precondition for this seed
      await hold(c, draws.slice(0, 99), 2000);
      await c.query('SELECT setseed($1)', [0.29]);
      const { rows } = await newcomer(c, 2999);
      expect(rows[0].support_code).toBe(draws[99]);
    } finally {
      c.release();
    }
  });

  it('an explicit code is kept as given, and a duplicate explicit code is still refused', async () => {
    await pool.query(`${insertSql}, support_code) VALUES ($1, $2, 'explicit@test', 'x', 'teacher', 'E', 'X', true, 'subject', false, '654321')`,
      [id(300), I.schoolA]);
    expect((await pool.query('SELECT support_code FROM users WHERE id = $1', [id(300)])).rows[0].support_code).toBe('654321');
    await expect(pool.query(`${insertSql}, support_code) VALUES ($1, $2, 'explicit2@test', 'x', 'teacher', 'E', 'Y', true, 'subject', false, '654321')`,
      [id(301), I.schoolA])).rejects.toThrow(/users_support_code_key/);
  });
});
