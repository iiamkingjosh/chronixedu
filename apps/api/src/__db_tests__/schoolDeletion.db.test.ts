/**
 * Deleting a school (apps/api/scripts/delete-school-data.js) and the audit purge path that makes
 * it complete (migration 048), run against a disposable school.
 *
 * What must hold:
 *   - a full run leaves ZERO rows for the school in every table — users and the school row
 *     included — and touches not one row of another school (which is checked NON-EMPTY first);
 *   - the one door 048 opens is the only one: a plain DELETE on audit_logs is still refused, a
 *     content UPDATE is still refused, processed_at is still write-once, and nothing outside the
 *     table owner can reach the purge function;
 *   - the record of the purge survives the deletion it records;
 *   - the notification worker does not throw when the queue rows it is working on are purged.
 *
 * platform_audit_logs gets no guard tests of its own, on purpose: it has no triggers (measured in
 * production 1 Oct 2026 and pinned below), so there is no DELETE/UPDATE guard to preserve. What
 * kept a school alive there was only its foreign keys, which the full-run test covers.
 */
import { Client } from 'pg';
import { seed, IDS as I, pool } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planSchoolDeletion, executeSchoolDeletion, resolveOperator, STEPS, NOT_DELETED, deleteAuthAccounts, describeAuthAccounts } = require('../../scripts/delete-school-data.js');

const OPERATOR = 'a1a1a1a1-0000-4000-8000-000000000001';
const PURGE = `SELECT chronixedu_purge.purge_school_audit_logs($1, $2) AS n`;

let client: Client;
beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, NULL, 'operator@chronix.test', 'x', 'super_admin', 'Op', 'Erator', true, false)`, [OPERATOR]);
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
});
afterEach(async () => { await client.end(); });
afterAll(async () => { await pool.end(); });

/** Row counts per table for one school, exactly as the script scopes them. */
async function footprint(schoolId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of STEPS as Array<{ table: string; where: string }>) {
    out[s.table] = (await pool.query(`SELECT count(*)::int AS n FROM ${s.table} WHERE ${s.where}`, [schoolId])).rows[0].n;
  }
  return out;
}
const sum = (f: Record<string, number>) => Object.values(f).reduce((a, b) => a + b, 0);

/** Audit rows for both schools, a queued notification, a platform audit row, and contacts. */
async function auditBothSchools() {
  const row = (school: string, user: string | null, action: string, nv = '{}') => pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, new_value) VALUES ($1, $2, $3, 'x', $1, $4::jsonb)`,
    [school, user, action, nv]);
  await row(I.schoolA, I.principalA, 'SETTINGS_CHANGE');
  await row(I.schoolA, I.mathTeacher, 'SCORE_ENTERED');
  await row(I.schoolA, I.principalA, 'PARENT_NOTIFICATION_QUEUED', JSON.stringify({ student_id: I.s1, notification_type: 'low_attendance' }));
  await row(I.schoolB, I.principalB, 'SETTINGS_CHANGE');
  await row(I.schoolB, I.principalB, 'SCORE_ENTERED');
  await pool.query(`INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, target_user_id) VALUES ($1, 'SCHOOL_SUSPENDED', $2, $3), ($1, 'SCHOOL_SUSPENDED', $4, NULL)`,
    [OPERATOR, I.schoolA, I.principalA, I.schoolB]);
  await pool.query(`INSERT INTO email_queue (to_email, subject, text_body, status) VALUES ($1, 'Welcome', 'Hello', 'pending')`, [`${I.s1User}@test`]);
  await pool.query(`UPDATE schools SET email = 'office@school-a.test', phone = '+2348000000001' WHERE id = $1`, [I.schoolA]);
  await pool.query(`UPDATE users SET phone = '+2348000000002' WHERE id = $1`, [I.parentA]);
}

describe('completeness: every table is either deleted or left with a reason', () => {
  it('no table is unclassified, none is both, and none is stale', async () => {
    const { rows } = await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    const all = rows.map(r => r.t);
    expect(all.length).toBeGreaterThan(40); // the control: the real schema was read
    const deleted = new Set((STEPS as Array<{ table: string }>).map(s => s.table));
    const left = new Set(Object.keys(NOT_DELETED));
    expect(all.filter(t => !deleted.has(t) && !left.has(t))).toEqual([]);
    expect([...deleted].filter(t => left.has(t))).toEqual([]);
    expect([...deleted, ...left].filter(t => !all.includes(t))).toEqual([]);
    // The tail must be: audit tables, then the users they name, then the school.
    expect((STEPS as Array<{ table: string }>).slice(-4).map(s => s.table)).toEqual(['audit_logs', 'platform_audit_logs', 'users', 'schools']);
  });
});

describe('migration 048: one door, and only one', () => {
  it("the purge deletes one school's audit rows and not another's", async () => {
    await auditBothSchools();
    const before = (await pool.query(`SELECT school_id, count(*)::int n FROM audit_logs GROUP BY 1`)).rows;
    expect(before.find(r => r.school_id === I.schoolB)?.n).toBe(2); // B is non-empty, or this proves nothing
    expect(before.find(r => r.school_id === I.schoolA)?.n).toBe(3);
    const n = (await client.query(PURGE, [I.schoolA, OPERATOR])).rows[0].n;
    expect(n).toBe(3);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE school_id = $1`, [I.schoolA])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE school_id = $1`, [I.schoolB])).rows[0].n).toBe(2);
  });

  it('a plain DELETE on audit_logs is still refused, as the owner', async () => {
    await auditBothSchools();
    await expect(pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [I.schoolA])).rejects.toThrow(/append-only.*DELETE is not permitted/);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE school_id = $1`, [I.schoolA])).rows[0].n).toBe(3);
  });

  it('a content UPDATE on audit_logs is still refused — 037 survived 048', async () => {
    await auditBothSchools();
    await expect(pool.query(`UPDATE audit_logs SET action_type = 'REWRITTEN' WHERE school_id = $1`, [I.schoolA]))
      .rejects.toThrow(/only processed_at may be updated/);
  });

  it('processed_at is still write-once', async () => {
    await auditBothSchools();
    const id = (await pool.query(`SELECT id FROM audit_logs WHERE school_id = $1 LIMIT 1`, [I.schoolA])).rows[0].id;
    await pool.query(`UPDATE audit_logs SET processed_at = now() WHERE id = $1`, [id]); // the first stamp is allowed
    await expect(pool.query(`UPDATE audit_logs SET processed_at = NULL WHERE id = $1`, [id])).rejects.toThrow(/write-once/);
  });

  it('nothing but the table owner can reach the function, and nobody can become the purger', async () => {
    const fn = 'chronixedu_purge.purge_school_audit_logs(uuid,uuid)';
    const priv = (await pool.query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') anon, has_function_privilege('authenticated', $1, 'EXECUTE') authd,
              has_function_privilege('service_role', $1, 'EXECUTE') svc, has_function_privilege(current_user, $1, 'EXECUTE') owner,
              has_schema_privilege('anon', 'chronixedu_purge', 'USAGE') anon_usage`, [fn])).rows[0];
    expect(priv).toEqual({ anon: false, authd: false, svc: false, owner: true, anon_usage: false });
    const acl = (await pool.query(`SELECT proacl::text acl, proowner::regrole::text owner, prosecdef FROM pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0];
    expect(acl.owner).toBe('chronixedu_audit_purger');
    expect(acl.prosecdef).toBe(true);
    expect(acl.acl).not.toMatch(/(^|[{,])=X/); // no PUBLIC entry
    const role = (await pool.query(`SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'chronixedu_audit_purger'`)).rows[0];
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false });
    const members = (await pool.query(
      `SELECT member::regrole::text FROM pg_auth_members WHERE roleid = 'chronixedu_audit_purger'::regrole AND (set_option OR inherit_option)`)).rows;
    expect(members).toEqual([]);
  });

  it('the purge refuses a missing id, an operator who is not a super admin, and an operator inside the school', async () => {
    await auditBothSchools();
    await expect(client.query(PURGE, [I.schoolA, null])).rejects.toThrow(/both required/);
    await expect(client.query(PURGE, [I.schoolA, I.principalB])).rejects.toThrow(/not an active Chronix super admin/);
    await pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [I.mathTeacher]); // a super admin who belongs to A
    await expect(client.query(PURGE, [I.schoolA, I.mathTeacher])).rejects.toThrow(/outside this school/);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE school_id = $1`, [I.schoolA])).rows[0].n).toBe(3);
  });

  it('platform_audit_logs has no guard to preserve — pinned, so adding one is a decision', async () => {
    const { rows } = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'platform_audit_logs'::regclass AND NOT tgisinternal`);
    expect(rows).toEqual([]);
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

describe('Auth accounts: logins, not users rows', () => {
  // On 2 Oct 2026 the plan reported "Supabase Auth accounts: 109" for a school whose 109 users had
  // no login between them, sent 109 deletes for accounts that did not exist, and one network blip
  // on one of them stopped the run. The test database has no Supabase Auth; build the one table
  // the script reads (the auth schema itself exists, for the stub functions).
  beforeAll(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text)`);
  });
  afterAll(async () => { await pool.query(`DROP TABLE IF EXISTS auth.users`); });

  it('counts the users that really have a login, and acts on those alone', async () => {
    await pool.query(`TRUNCATE auth.users`);
    await pool.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'principal@a.test')`, [I.principalA]);
    const plan = await planSchoolDeletion(client, I.schoolA);
    expect(plan.userIds.length).toBeGreaterThan(1); // many users rows, established first
    expect(plan.authAccounts).toEqual([I.principalA]);
    expect(plan.authUserIds).toEqual([I.principalA]);
    expect(describeAuthAccounts(plan)).toBe(`Supabase Auth accounts: 1 (of ${plan.userIds.length} users; the other ${plan.userIds.length - 1} have no login)`);
    expect(describeAuthAccounts({ ...plan, authAccounts: plan.userIds })).toBe(`Supabase Auth accounts: ${plan.userIds.length} (every user has a login)`);
    expect(describeAuthAccounts({ ...plan, userIds: [], authAccounts: [] })).toBe('Supabase Auth accounts: 0 (the school has no users)');
  });

  it('says it could not check, and tries every user id, when the database has no auth.users', async () => {
    await pool.query(`DROP TABLE auth.users`);
    try {
      const plan = await planSchoolDeletion(client, I.schoolA);
      expect(plan.authAccounts).toBeNull();
      expect(plan.authUserIds).toEqual(plan.userIds);
      expect(describeAuthAccounts(plan)).toMatch(/^Supabase Auth accounts: not checked — .* all \d+ user id\(s\) will be tried$/);
    } finally {
      await pool.query(`CREATE TABLE auth.users (id uuid PRIMARY KEY, email text)`);
    }
  });

  it('retries a passing error, treats "not found" as gone, and still stops on an error that persists', async () => {
    const calls: string[] = [];
    const answers: Record<string, Array<{ message: string } | null>> = {
      ok: [null],
      blip: [{ message: 'TLS handshake failure' }, null],
      gone: [{ message: 'User not found' }],
      down: [{ message: 'connect ECONNREFUSED' }, { message: 'connect ECONNREFUSED' }, { message: 'connect ECONNREFUSED' }],
    };
    const admin = { auth: { admin: { deleteUser: async (id: string) => {
      calls.push(id);
      return { error: answers[id].shift() ?? null };
    } } } };
    const failures = await deleteAuthAccounts(admin, ['ok', 'blip', 'gone', 'down'], { attempts: 3, waitMs: 0 });
    expect(failures).toEqual([{ id: 'down', message: 'connect ECONNREFUSED' }]);
    expect(calls).toEqual(['ok', 'blip', 'blip', 'gone', 'down', 'down', 'down']);
  });
});

describe('dry run', () => {
  it('lists what it would delete and every address it would remove, and changes nothing', async () => {
    await auditBothSchools();
    const before = await footprint(I.schoolA);
    expect(before.students).toBe(3); // the non-empty state, established first
    expect(before.audit_logs).toBe(3);
    const plan = await planSchoolDeletion(client, I.schoolA);
    expect(plan.school.slug).toBe('school-a');
    expect(plan.steps.find((s: { table: string }) => s.table === 'schools').rows).toBe(1);
    // SendGrid suppressions and Termii history outlive us: every address is printed before it goes.
    expect(plan.emails).toEqual(expect.arrayContaining(['office@school-a.test', `${I.principalA}@test`, `${I.parentA}@test`]));
    expect(plan.emails.some((e: string) => e.includes(I.principalB))).toBe(false);
    expect(plan.phones).toEqual(['+2348000000001', '+2348000000002']);
    expect(await footprint(I.schoolA)).toEqual(before);
  });
});

describe('the real run, on a disposable school', () => {
  it('leaves ZERO rows for the school in every table — users and the school row included', async () => {
    await auditBothSchools();
    const before = await footprint(I.schoolA);
    expect(before.schools).toBe(1);
    expect(before.users).toBeGreaterThan(1);
    expect(before.audit_logs).toBe(3);
    expect(before.platform_audit_logs).toBe(1);
    expect(before.email_queue).toBe(1);

    await executeSchoolDeletion(client, I.schoolA, OPERATOR);

    const after = await footprint(I.schoolA);
    for (const [table, n] of Object.entries(after)) expect(`${table}: ${n}`).toBe(`${table}: 0`);
    expect((await pool.query(`SELECT 1 FROM schools WHERE id = $1`, [I.schoolA])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM users WHERE id = $1`, [I.principalA])).rowCount).toBe(0);
  });

  it('the record of the purge survives the deletion it records', async () => {
    await auditBothSchools();
    await executeSchoolDeletion(client, I.schoolA, OPERATOR);
    const { rows } = await pool.query(
      `SELECT platform_admin_id, target_school_id, metadata FROM platform_audit_logs WHERE action_type = 'SCHOOL_AUDIT_PURGED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform_admin_id: OPERATOR, target_school_id: null, metadata: { school_id: I.schoolA, audit_logs_deleted: 3 } });
  });

  it('does not touch one row of any other school', async () => {
    await auditBothSchools();
    const schoolB = await footprint(I.schoolB);
    expect(schoolB.audit_logs).toBe(2); // B has audit rows to lose
    expect(schoolB.platform_audit_logs).toBe(1);
    expect(sum(schoolB)).toBeGreaterThan(5);
    await executeSchoolDeletion(client, I.schoolA, OPERATOR);
    expect(await footprint(I.schoolB)).toEqual(schoolB);
  });

  it('rolls back everything if any row would remain', async () => {
    await auditBothSchools();
    // An operator who is not a super admin makes the purge refuse after every child table was emptied.
    await expect(executeSchoolDeletion(client, I.schoolA, I.principalB)).rejects.toThrow(/not an active Chronix super admin/);
    expect((await footprint(I.schoolA)).students).toBe(3);
  });

  it('resolves the operator by email, and refuses anyone but an active super admin', async () => {
    expect(await resolveOperator(client, 'OPERATOR@chronix.test')).toBe(OPERATOR);
    await expect(resolveOperator(client, `${I.principalA}@test`)).rejects.toThrow(/not an active Chronix super admin/);
  });

  it('a rerun finds nothing and says so', async () => {
    await auditBothSchools();
    await executeSchoolDeletion(client, I.schoolA, OPERATOR);
    const again = await planSchoolDeletion(client, I.schoolA);
    expect(again.school).toBeNull();
    expect(again.total).toBe(0);
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
});
