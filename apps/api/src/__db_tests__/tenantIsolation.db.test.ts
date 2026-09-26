/**
 * T3-style isolation checks that run in CI (Architecture Guide §2.2 rule 4).
 * Structural: every public table has RLS; anon can read nothing.
 * Behavioural: a School B principal is refused on School A routes.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();

beforeAll(seed);
afterAll(() => pool.end());

describe('RLS coverage', () => {
  it('every public table has row level security enabled', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      // No carve-out. schema_migrations used to be excluded BY NAME here, which made
      // this assertion quietly mean "every public table except that one" — an
      // invariant with a silent asterisk. Migration 034 enables RLS on it and on
      // migration_runs, so the claim in this test's name is now literally true.
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`
    );
    expect(rows.map(r => r.relname)).toEqual([]);
  });

  it.each(['payments', 'fee_invoices', 'report_cards', 'scores', 'students', 'users', 'email_queue', 'subject_result_status'])(
    'anon cannot read %s',
    async table => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE anon');
        let visible = 0;
        try {
          visible = (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
        } catch (err) {
          expect((err as Error).message).toMatch(/permission denied/);
        }
        expect(visible).toBe(0);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
  );

  it('authenticated JWT for School B sees no School A students', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ school_id: I.schoolB, role: 'principal' })]);
      await c.query('SET LOCAL ROLE authenticated');
      const { rows } = await c.query(`SELECT DISTINCT school_id FROM students`);
      expect(rows.map(r => r.school_id)).toEqual([I.schoolB]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('API cross-tenant refusal', () => {
  const routes: Array<[string, string]> = [
    ['get', `/api/schools/${I.schoolA}/students`],
    ['get', `/api/schools/${I.schoolA}/scores/class-sheet?class_id=${I.jss2a}&subject_id=${I.math}&term_id=${I.termA}`],
    ['get', `/api/schools/${I.schoolA}/results/approval-dashboard?term_id=${I.termA}`],
    ['get', `/api/schools/${I.schoolA}/dashboard/principal/overview`],
    ['post', `/api/schools/${I.schoolA}/results/approve`],
    ['post', `/api/schools/${I.schoolA}/results/publish`],
  ];
  it.each(routes)('%s %s → 403 for School B principal', async (method, url) => {
    const agent = request(app) as unknown as Record<string, (u: string) => request.Test>;
    const r = await agent[method](url).set('Authorization', tokens.principalB()).send({ class_id: I.jss2a, term_id: I.termA });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });
});
