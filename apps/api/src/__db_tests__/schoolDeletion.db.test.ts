/**
 * The school-deletion script (apps/api/scripts/delete-school-data.js), run against a
 * disposable school — the runbook's requirement that it be tested before it is needed.
 *
 * What must hold: the dry run changes nothing; the real run removes every row of the target
 * school that the audit rule does not protect, and touches NOT ONE row of any other school;
 * and what stays is exactly what the audit rule keeps — the audit rows, the users they name,
 * and the school row — reported, not silently left.
 */
import { Client } from 'pg';
import { seed, IDS as I, pool } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planSchoolDeletion, executeSchoolDeletion, STEPS, NOT_DELETED } = require('../../scripts/delete-school-data.js');

let client: Client;
beforeEach(async () => {
  await seed();
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
});
afterEach(async () => { await client.end(); });
afterAll(async () => { await pool.end(); });

/** Row counts per table for one school: school_id tables directly, the rest through students/users. */
async function footprint(schoolId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of STEPS as Array<{ table: string; where: string }>) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${s.table} WHERE ${s.where.replace(/AND id NOT IN[\s\S]*/, '')}`, [schoolId]);
    out[s.table] = rows[0].n;
  }
  return out;
}

async function auditPrincipalA() {
  // The wall: one audit row naming School A and its principal, as any settings change writes.
  await pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, new_value)
     VALUES ($1, $2, 'SETTINGS_CHANGE', 'school_settings', $1, '{"field":"x"}'::jsonb)`,
    [I.schoolA, I.principalA]);
  await pool.query(`INSERT INTO email_queue (to_email, subject, text_body, status) VALUES ($1, 'Welcome', 'Hello', 'pending')`, [`${I.s1User}@test`]);
}

describe('completeness — every table is either deleted or left with a reason', () => {
  it('no table is unclassified, none is both, and none is stale', async () => {
    const { rows } = await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    const all = rows.map(r => r.t);
    expect(all.length).toBeGreaterThan(40); // the control: the real schema was read
    const deleted = new Set((STEPS as Array<{ table: string }>).map(s => s.table));
    const left = new Set(Object.keys(NOT_DELETED));
    expect(all.filter(t => !deleted.has(t) && !left.has(t))).toEqual([]);
    expect([...deleted].filter(t => left.has(t))).toEqual([]);
    expect([...deleted, ...left].filter(t => !all.includes(t))).toEqual([]);
  });
});

describe('stored files', () => {
  // The test database has no Supabase Storage; build the one table the script reads.
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS storage; CREATE TABLE IF NOT EXISTS storage.objects (bucket_id text, name text)`);
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA storage CASCADE`); });

  it("lists every one of School A's files, in both buckets, and none of School B's", async () => {
    const a = I.schoolA, b = I.schoolB;
    const mine = [
      ['school-assets', `schools/${a}/logo.png`],
      ['school-assets', `schools/${a}/students/x/photo.jpg`],
      ['school-assets', `schools/${a}/assignments/y/submissions/z.pdf`],
      ['report-cards', `${a}/term/student.pdf`],
      ['report-cards', `receipts/${a}/payment.pdf`],
      ['report-cards', `transcripts/${a}/student.pdf`],
    ];
    const theirs = [
      ['school-assets', `schools/${b}/logo.png`],
      ['report-cards', `${b}/term/student.pdf`],
      ['report-cards', `receipts/${b}/payment.pdf`],
      ['school-assets', `${a}/wrong-bucket-layout.png`], // A's id, but not a path the API writes
    ];
    await pool.query(`TRUNCATE storage.objects`);
    for (const [bucket, name] of [...mine, ...theirs]) await pool.query(`INSERT INTO storage.objects VALUES ($1, $2)`, [bucket, name]);
    const plan = await planSchoolDeletion(client, a);
    expect(plan.storageObjects.map((f: { bucket: string; name: string }) => `${f.bucket}/${f.name}`).sort())
      .toEqual(mine.map(([bk, n]) => `${bk}/${n}`).sort());
  });

  it('says so, rather than reporting zero, when the database has no Storage at all', async () => {
    await pool.query(`DROP SCHEMA storage CASCADE`);
    try {
      expect((await planSchoolDeletion(client, I.schoolA)).storageObjects).toBeNull();
    } finally {
      await pool.query(`CREATE SCHEMA storage; CREATE TABLE storage.objects (bucket_id text, name text)`);
    }
  });
});

describe('dry run', () => {
  it('lists what it would delete, and changes nothing', async () => {
    await auditPrincipalA();
    const before = await footprint(I.schoolA);
    expect(before.students).toBe(3); // the non-empty state, established first
    const plan = await planSchoolDeletion(client, I.schoolA);
    expect(plan.steps.find((s: { table: string }) => s.table === 'students').rows).toBe(3);
    expect(await footprint(I.schoolA)).toEqual(before);
  });
});

describe('the real run, on a disposable school', () => {
  it('removes everything of School A the audit rule does not protect — and keeps exactly what it does', async () => {
    await auditPrincipalA();
    const before = await footprint(I.schoolA);
    expect(before.students).toBe(3);
    expect(before.email_queue).toBe(1);

    const done = await executeSchoolDeletion(client, I.schoolA);

    const after = await footprint(I.schoolA);
    for (const [table, n] of Object.entries(after)) {
      if (table === 'users') continue;
      expect(`${table}: ${n}`).toBe(`${table}: 0`);
    }
    // Kept, and reported: the audit row, the one user it names, the school row.
    const users = await pool.query<{ id: string }>(`SELECT id FROM users WHERE school_id = $1`, [I.schoolA]);
    expect(users.rows.map(r => r.id)).toEqual([I.principalA]);
    expect(done.retained).toMatchObject({ audit_logs: 1, users: 1, school_row: true });
    expect(done.schoolDeleted).toBe(false);
    expect((await pool.query(`SELECT 1 FROM schools WHERE id = $1`, [I.schoolA])).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE school_id = $1`, [I.schoolA])).rowCount).toBe(1);
    // Every account the school had is listed for Supabase Auth, audited or not.
    expect(done.authUserIds.length).toBeGreaterThan(1);
    expect(done.authUserIds).toContain(I.principalA);
  });

  it("does not touch one row of any other school", async () => {
    const schoolB = await footprint(I.schoolB);
    expect(Object.values(schoolB).reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // B has data to lose
    await executeSchoolDeletion(client, I.schoolA);
    expect(await footprint(I.schoolB)).toEqual(schoolB);
    expect((await pool.query(`SELECT 1 FROM schools WHERE id = $1`, [I.schoolB])).rowCount).toBe(1);
  });

  it('with no audit rows at all, the school row goes too', async () => {
    const done = await executeSchoolDeletion(client, I.schoolA);
    expect(done.schoolDeleted).toBe(true);
    expect((await pool.query(`SELECT 1 FROM schools WHERE id = $1`, [I.schoolA])).rowCount).toBe(0);
  });

  it('migration 047 frees a deleted config, and only a deleted one', async () => {
    const cfg = (await pool.query<{ id: string }>(`SELECT config_id AS id FROM assessment_components WHERE config_id IN (SELECT id FROM assessment_configs WHERE school_id = $1) LIMIT 1`, [I.schoolA])).rows[0].id;
    // Emptying a config that still exists is still refused at COMMIT…
    await expect(pool.query(`DELETE FROM assessment_components WHERE config_id = $1`, [cfg])).rejects.toThrow(/must equal 100; got 0/);
    // …and so is a partial delete that unbalances it.
    const one = (await pool.query<{ id: string }>(`SELECT id FROM assessment_components WHERE config_id = $1 LIMIT 1`, [cfg])).rows[0].id;
    await expect(pool.query(`DELETE FROM assessment_components WHERE id = $1`, [one])).rejects.toThrow(/must equal 100/);
    // Deleting the config with its components, in one transaction, commits.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DELETE FROM scores WHERE component_id IN (SELECT id FROM assessment_components WHERE config_id = $1)`, [cfg]);
      await c.query(`DELETE FROM assessment_components WHERE config_id = $1`, [cfg]);
      await c.query(`DELETE FROM assessment_configs WHERE id = $1`, [cfg]);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect((await pool.query(`SELECT 1 FROM assessment_configs WHERE id = $1`, [cfg])).rowCount).toBe(0);
  });

  it('is safe to run twice — the second run finds nothing to do', async () => {
    await auditPrincipalA();
    await executeSchoolDeletion(client, I.schoolA);
    const again = await planSchoolDeletion(client, I.schoolA);
    expect(again.steps.filter((s: { rows: number }) => s.rows > 0)).toEqual([]);
  });
});
