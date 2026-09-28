/**
 * A settings audit row's old value must be the state that actually preceded the change.
 *
 * `PATCH /academic-config` (grading scales, pass marks, level overrides) and
 * `PATCH /fee-config` passed a literal `null` to logSettingsChange as the old value. Because
 * the audit stores `{ field, value }`, the column was never NULL — it read as a recorded
 * prior value of "nothing". Found in production: two saves of the same level override
 * eighteen seconds apart, the second claiming its predecessor had set nothing. A missing
 * value announces itself; a false one is what an audit trail exists to prevent, and this
 * table is append-only and privilege-protected precisely so its contents can be trusted.
 *
 * Asserted positively (CLAUDE.md doctrine 16): the second of two saves must name the
 * first's value. An assertion that the old value is null would pass on the broken code.
 */
import request from 'supertest';
import { Pool } from 'pg';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeEach(seed);
afterAll(async () => {
  await pool.end();
  await owner.end();
});

const academic = (body: object) =>
  request(app).patch(`${base}/academic-config`).set('Authorization', tokens.principalA()).send(body);
const fees = (min: string) =>
  request(app).patch(`${base}/fee-config`).set('Authorization', tokens.principalA()).send({ min_part_payment: min });

interface Change { old: { field: string; value: Record<string, unknown> | null }; neu: { field: string; value: Record<string, unknown> } }

async function settingsChanges(): Promise<Change[]> {
  const { rows } = await owner.query<{ old_value: Change['old']; new_value: Change['neu'] }>(
    `SELECT old_value, new_value FROM audit_logs
      WHERE school_id = $1 AND action_type = 'SETTINGS_CHANGE'
      ORDER BY created_at, id`, [I.schoolA]);
  return rows.map(r => ({ old: r.old_value, neu: r.new_value }));
}

describe('academic config', () => {
  it('the second of two saves records the first save’s value as its prior', async () => {
    expect((await academic({ level_overrides: { Senior: { promotion_cutoff: 60 } } })).status).toBe(200);
    expect((await academic({ level_overrides: { Senior: { promotion_cutoff: 70 } } })).status).toBe(200);

    const [first, second] = await settingsChanges();
    expect(first.neu.value).toEqual({ level_overrides: { Senior: { promotion_cutoff: 60 } } });
    // The property the old code broke: this read { level_overrides: null }.
    expect(second.old.value).toEqual(first.neu.value);
    expect(second.neu.value).toEqual({ level_overrides: { Senior: { promotion_cutoff: 70 } } });
  });

  it('records a prior value that existed before any audited change', async () => {
    // Set directly, as onboarding or an earlier version of the product would have.
    await owner.query(
      `INSERT INTO school_settings (school_id, academic_config) VALUES ($1, '{"promotion_cutoff": 45}'::jsonb)`,
      [I.schoolA]);
    expect((await academic({ promotion_cutoff: 50 })).status).toBe(200);

    const [change] = await settingsChanges();
    expect(change.old.value).toEqual({ promotion_cutoff: 45 });
    expect(change.neu.value).toEqual({ promotion_cutoff: 50 });
  });

  it('records only the keys it changed, so old and new line up key for key', async () => {
    await owner.query(
      `INSERT INTO school_settings (school_id, academic_config)
       VALUES ($1, '{"promotion_cutoff": 45, "grading_scale": [{"grade":"A","min":0,"max":100,"label":"A","remark":""}]}'::jsonb)`,
      [I.schoolA]);
    await academic({ promotion_cutoff: 50 });
    const [change] = await settingsChanges();
    expect(Object.keys(change.old.value ?? {})).toEqual(['promotion_cutoff']);
  });

  it('records null only for a genuinely first setting — the row did not exist', async () => {
    const before = await owner.query(`SELECT count(*)::int n FROM school_settings WHERE school_id = $1`, [I.schoolA]);
    expect(before.rows[0].n).toBe(0); // the precondition that makes null the true answer
    await academic({ promotion_cutoff: 40 });
    const [change] = await settingsChanges();
    expect(change.old.value).toEqual({ promotion_cutoff: null });
  });
});

describe('concurrent saves', () => {
  it('chain — each records the value the other wrote — rather than both claiming the same prior', async () => {
    await owner.query(
      `INSERT INTO school_settings (school_id, academic_config) VALUES ($1, '{"promotion_cutoff": 40}'::jsonb)`,
      [I.schoolA]);

    // Deterministic, not a timing race: hold the row lock, start two saves, confirm BOTH
    // are waiting on it, then release. A version that read the prior value without
    // FOR UPDATE would read 40 for both while the lock is held, and fail every time.
    const holder = await owner.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM school_settings WHERE school_id = $1 FOR UPDATE`, [I.schoolA]);

    const saves = [academic({ promotion_cutoff: 50 }), academic({ promotion_cutoff: 60 })].map(r => r.then(x => x));

    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      await new Promise(r => setTimeout(r, 50));
      waiting = (await owner.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n;
    }
    expect(waiting).toBe(2); // the precondition: both saves are blocked on the held lock

    await holder.query('COMMIT');
    holder.release();
    for (const res of await Promise.all(saves)) expect(res.status).toBe(200);

    const [a, b] = await settingsChanges();
    expect(a.old.value).toEqual({ promotion_cutoff: 40 });
    expect(b.old.value).toEqual(a.neu.value); // the second saw the first's write
  });
});

describe('fee config', () => {
  it('the second save records the first save’s minimum as its prior', async () => {
    // The seed has no settings row: the old UPDATE matched nothing here and still said "updated".
    expect((await fees('1000.00')).status).toBe(200);
    expect((await fees('2500.00')).status).toBe(200);

    const [first, second] = await settingsChanges();
    expect(first.neu.value).toEqual({ min_part_payment_kobo: 100000 });
    expect(second.old.value).toEqual({ min_part_payment_kobo: 100000 });

    const stored = await owner.query(`SELECT fee_config->>'min_part_payment_kobo' AS k FROM school_settings WHERE school_id = $1`, [I.schoolA]);
    expect(stored.rows[0].k).toBe('250000');
  });
});
