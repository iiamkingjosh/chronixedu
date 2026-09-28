/**
 * Which database user is each connection, in each mode?
 *
 * The C-4a role-mode run (`npm run test:db:roles`) is worth something only if the app pool
 * really is chronixedu_app. If the switch silently failed — a config not loaded, an env
 * var overwritten — every route would run as the owner, nothing would be refused, and the
 * run would report the same zero product failures as a correct one (CLAUDE.md doctrine
 * 16). So the mode is asserted, not inferred from the result.
 */
import { Client } from 'pg';
import { pool } from './helpers';

const roleMode = process.env.C4A_ROLES === '1';

afterAll(async () => {
  await pool.end();
});

it(`the app pool runs as ${roleMode ? 'chronixedu_app' : 'the owner'} in this mode`, async () => {
  const { rows } = await pool.query<{ u: string }>(`SELECT current_user AS u`);
  if (roleMode) {
    expect(rows[0].u).toBe('chronixedu_app');
  } else {
    // In an ordinary run the pool is TEST_DATABASE_URL's user, which owns the tables.
    expect(rows[0].u).toBe(new URL(process.env.TEST_DATABASE_URL!).username);
  }
});

it('the seed connection is the table owner in every mode', async () => {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    const { rows } = await c.query<{ u: string; owns: boolean }>(
      `SELECT current_user AS u,
              (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'schools' AND relkind = 'r') = current_user AS owns`
    );
    expect(rows[0].owns).toBe(true);
  } finally {
    await c.end();
  }
});

(roleMode ? it : it.skip)('in role mode, the app pool cannot TRUNCATE — the reason seed() uses the owner', async () => {
  await expect(pool.query(`TRUNCATE notices`)).rejects.toThrow(/permission denied/);
});
