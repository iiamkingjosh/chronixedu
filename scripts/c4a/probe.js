#!/usr/bin/env node
/**
 * C-4a privilege probe — LOCAL REBUILD ONLY. Refuses any host but localhost.
 *
 *   PROBE_DATABASE_URL=postgres://postgres:postgres@localhost:5470/chronixedu_test node scripts/c4a/probe.js
 *
 * 1. Privilege probes, each attempted as the role (SET LOCAL ROLE), each in its own
 *    rolled-back transaction, in two phases:
 *      Phase B — docs/c4a/grants.sql exactly as proposed.
 *      Phase A — the same with its REVOKEs undone.
 *    A REVOKE earns its place only if some probe differs between the phases. Probes that
 *    expect success assert rows affected / rows seen — an UPDATE matching nothing raises
 *    no error either (doctrine 16).
 * 2. The boundary check (scripts/sql/c4a_boundary_check.sql) on the proposed grants —
 *    it must return nothing — and then proof that it CAN return something: a table
 *    created the way a future migration would, and a new bookkeeping table marked
 *    owner-only, each inside a rolled-back transaction. An empty result is only evidence
 *    once the check has been seen to fire.
 *
 * Writes docs/c4a/probe.md and docs/c4a/effective_privileges.json (as Postgres reports
 * them — not re-described from grants.sql).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require(path.resolve(__dirname, '../../node_modules/pg'));

const URL_ = process.env.PROBE_DATABASE_URL;
if (!URL_) throw new Error('PROBE_DATABASE_URL is required');
const host = new URL(URL_).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  throw new Error(`Refusing to probe ${host}: this creates roles and policies, and is for a disposable local rebuild only.`);
}

const ROOT = path.resolve(__dirname, '../..');
const GRANTS = fs.readFileSync(path.join(ROOT, 'docs/c4a/grants.sql'), 'utf8');
const CHECK = fs.readFileSync(path.join(ROOT, 'scripts/sql/c4a_boundary_check.sql'), 'utf8');
const UNDO_REVOKES = `
  GRANT SELECT, INSERT, UPDATE, DELETE ON schema_migrations, migration_runs TO chronixedu_app;
  GRANT UPDATE, DELETE ON audit_logs TO chronixedu_app;`;

const SCHOOL = 'c4a00000-0000-4000-8000-000000000001';
const USER = 'c4a00000-0000-4000-8000-000000000002';
const LOGIN_COLS = 'id, school_id, role, title, email, first_name, last_name, is_active, support_code, must_change_password';

/** [role, name, sql, {A, B}, why] — expectations: 'ok' | 'ok:<n>' | 'ok:rows=<n>' | 'denied' | 'trigger' */
const PROBES = [
  ['chronixedu_app', 'TRUNCATE a tenant table', `TRUNCATE notices`, { A: 'denied', B: 'denied' },
    'Never granted — DML only. Absent by construction; no REVOKE written.'],
  ['chronixedu_app', 'CREATE TABLE in public', `CREATE TABLE c4a_probe_table (id int)`, { A: 'denied', B: 'denied' },
    'PG15+ gives PUBLIC no CREATE on public, and USAGE is not CREATE. No REVOKE needed; none written.'],
  ['chronixedu_app', 'ALTER TABLE audit_logs DISABLE TRIGGER ALL', `ALTER TABLE audit_logs DISABLE TRIGGER ALL`, { A: 'denied', B: 'denied' },
    'Owner-only. Doctrine 6 lists this as a way past the append-only triggers — for the owner, not the app role.'],
  ['chronixedu_app', 'SET session_replication_role = replica', `SET LOCAL session_replication_role = replica`, { A: 'denied', B: 'denied' },
    'Superuser-only. The other escape hatch doctrine 6 names.'],
  ['chronixedu_app', 'DELETE FROM audit_logs', `DELETE FROM audit_logs WHERE school_id = '${SCHOOL}'`, { A: 'trigger', B: 'denied' },
    'A: privilege allows it and the 036 trigger stops it. B: refused before the trigger is reached.'],
  ['chronixedu_app', 'UPDATE audit_logs content column', `UPDATE audit_logs SET action_type = 'TAMPERED' WHERE school_id = '${SCHOOL}'`, { A: 'trigger', B: 'denied' },
    'Same shape as DELETE.'],
  ['chronixedu_app', 'UPDATE audit_logs SET processed_at (the worker)', `UPDATE audit_logs SET processed_at = now() WHERE id = '__AUDIT_FIXTURE__'`, { A: 'ok:1', B: 'ok:1' },
    'MUST still work: the notification queue marker. A wholesale UPDATE revoke would have been migration 036 again.'],
  ['chronixedu_app', 'INSERT INTO audit_logs', `INSERT INTO audit_logs (school_id, action_type, entity) VALUES ('${SCHOOL}', 'C4A_PROBE', 'probe')`, { A: 'ok:1', B: 'ok:1' },
    'Every sensitive write audits (doctrine 10).'],
  ['chronixedu_app', 'SELECT schema_migrations', `SELECT count(*) FROM schema_migrations`, { A: 'ok', B: 'denied' },
    'Owner-only by its comment; revoked by the loop that reads the comment.'],
  ['chronixedu_app', 'SELECT migration_runs', `SELECT count(*) FROM migration_runs`, { A: 'ok', B: 'denied' }, 'As above.'],
  ['chronixedu_app', 'Read a tenant table through RLS', `SELECT count(*)::int AS n FROM schools WHERE id = '${SCHOOL}'`, { A: 'ok:rows=1', B: 'ok:rows=1' },
    'Without app_bypass_schools this returns 0 rows, silently. Asserting 1 proves the policy admits the role.'],
  ['chronixedu_app', 'Ordinary DML: UPDATE a tenant row', `UPDATE schools SET name = name WHERE id = '${SCHOOL}'`, { A: 'ok:1', B: 'ok:1' },
    'Visible AND writable: USING (true) WITH CHECK (true).'],

  ['chronixedu_login', 'login: read the ten user columns', `SELECT count(*)::int AS n FROM (SELECT ${LOGIN_COLS} FROM users WHERE id = '${USER}') x`, { A: 'ok:rows=1', B: 'ok:rows=1' },
    'Exactly what POST /login selects.'],
  ['chronixedu_login', 'login: stamp last_login_at', `UPDATE users SET last_login_at = now() WHERE id = '${USER}'`, { A: 'ok:1', B: 'ok:1' },
    'Column-scoped, in the same style as processed_at.'],
  ['chronixedu_login', 'login: read subscription_tier', `SELECT count(*)::int AS n FROM (SELECT subscription_tier FROM schools WHERE id = '${SCHOOL}') x`, { A: 'ok:rows=1', B: 'ok:rows=1' },
    'The read the first inventory missed (a generic type argument hid pg.query).'],
  ['chronixedu_login', 'login: read password_hash', `SELECT password_hash FROM users WHERE id = '${USER}'`, { A: 'denied', B: 'denied' },
    'Login verifies through Supabase Auth, so the role serving unauthenticated callers cannot read a hash.'],
  ['chronixedu_login', 'login: change a role', `UPDATE users SET role = 'super_admin' WHERE id = '${USER}'`, { A: 'denied', B: 'denied' },
    'Only last_login_at is writable.'],
  ['chronixedu_login', 'login: create a user', `INSERT INTO users (id, email, password_hash, role, first_name, last_name) VALUES (gen_random_uuid(), 'x@probe', 'x', 'teacher', 'x', 'x')`, { A: 'denied', B: 'denied' },
    'Why /create-user moved to the app pool: otherwise this role would need it.'],
  ['chronixedu_login', 'login: read scores', `SELECT count(*) FROM scores`, { A: 'denied', B: 'denied' },
    'The point of the separate role: a flaw on the unauthenticated path reaches no tenant data.'],
];

function classify(err) {
  if (!err) return 'ok';
  if (/permission denied|must be owner|must be superuser|not permitted to set parameter/i.test(err.message)) return 'denied';
  if (/append-only/i.test(err.message)) return 'trigger';
  return 'error';
}

async function runProbes(c, phase) {
  const out = [];
  for (const [role, name, sql, expect, why] of PROBES) {
    let got, detail = '';
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    try {
      const r = await c.query(sql);
      if (/count\(\*\)::int AS n/.test(sql)) got = `ok:rows=${r.rows[0].n}`;
      else if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) got = `ok:${r.rowCount}`;
      else got = 'ok';
      detail = got;
    } catch (err) {
      got = classify(err);
      detail = err.message.split('\n')[0];
    }
    await c.query('ROLLBACK');
    const want = expect[phase];
    out.push({ phase, role, name, want, got, pass: got === want, detail, why });
  }
  return out;
}

const check = async c => (await c.query(CHECK)).rows.map(r => r.violation);

/** Run the boundary check against a hypothetical change, then roll it back. */
async function checkAfter(c, ddl) {
  await c.query('BEGIN');
  try {
    await c.query(ddl);
    return await check(c);
  } finally {
    await c.query('ROLLBACK');
  }
}

(async () => {
  const c = new Client({ connectionString: URL_ });
  await c.connect();

  // Roles NOLOGIN — a probe needs no password, and none belongs in the repo.
  for (const role of ['chronixedu_app', 'chronixedu_login']) {
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
  }
  // Fixtures, as owner: every UPDATE/DELETE/SELECT probe has a row to hit, because a
  // probe against an empty table proves nothing.
  await c.query(`INSERT INTO schools (id, name, slug) VALUES ($1, 'C4A Probe School', 'c4a-probe') ON CONFLICT (id) DO NOTHING`, [SCHOOL]);
  await c.query(`INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active)
                 VALUES ($1, $2, 'c4a-probe@test', 'x', 'teacher', 'C4A', 'Probe', true) ON CONFLICT (id) DO NOTHING`, [USER, SCHOOL]);
  // Targeted by id: audit_logs is append-only, so fixtures from earlier runs of this probe
  // cannot be removed, and a probe matching "any unprocessed row for the school" counted 2
  // on the second run. It must hit exactly the row it created.
  const auditFixture = (await c.query(
    `INSERT INTO audit_logs (school_id, action_type, entity) VALUES ($1, 'C4A_FIXTURE', 'probe') RETURNING id`, [SCHOOL])).rows[0].id;
  for (const probe of PROBES) probe[2] = probe[2].replace('__AUDIT_FIXTURE__', auditFixture);

  await c.query(GRANTS);
  const B = await runProbes(c, 'B');

  // ── Boundary check: clean on the proposal, and seen to fire ──────────────────────────
  const clean = await check(c);
  const futureTable = await checkAfter(c,
    `CREATE TABLE c4a_future_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid)`);
  const futureBookkeeping = await checkAfter(c,
    `CREATE TABLE c4a_future_bookkeeping (id int);
     COMMENT ON TABLE c4a_future_bookkeeping IS 'owner-only: a hypothetical new bookkeeping table';`);
  const futureBookkeepingDone = await checkAfter(c,
    `CREATE TABLE c4a_future_bookkeeping (id int);
     COMMENT ON TABLE c4a_future_bookkeeping IS 'owner-only: a hypothetical new bookkeeping table';
     REVOKE ALL ON c4a_future_bookkeeping FROM chronixedu_app;`);
  const futureTableDone = await checkAfter(c,
    `CREATE TABLE c4a_future_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid);
     CREATE POLICY app_bypass_c4a_future_table ON c4a_future_table FOR ALL TO chronixedu_app USING (true) WITH CHECK (true);`);

  // The platform dependency: a body naming schema auth, as the old local stub's did.
  const authBody = await checkAfter(c,
    `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
       $f$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $f$`);

  const privs = await c.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'chronixedu_app' AND table_schema = 'public' ORDER BY 1, 2`);
  const colPrivs = await c.query(
    `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = 'chronixedu_app' AND table_schema = 'public' AND table_name = 'audit_logs'
        AND privilege_type = 'UPDATE' ORDER BY 1, 2`);
  const loginPrivs = await c.query(
    `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = 'chronixedu_login' AND table_schema = 'public' ORDER BY 1, 3, 2`);
  const policies = await c.query(
    `SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'app_bypass_%'`);
  const tables = await c.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`);

  await c.query(UNDO_REVOKES);
  const A = await runProbes(c, 'A');
  const dirty = await check(c); // the REVOKEs undone — the check should notice
  await c.end();

  const eff = {};
  for (const r of privs.rows) (eff[r.table_name] ??= []).push(r.privilege_type);
  fs.writeFileSync(path.join(ROOT, 'docs/c4a/effective_privileges.json'), JSON.stringify({
    source: 'information_schema, after applying docs/c4a/grants.sql to a local rebuild (Phase B)',
    tables: eff,
    audit_logs_update_columns: colPrivs.rows.map(r => r.column_name),
    login_column_privileges: loginPrivs.rows.map(r => `${r.privilege_type} ${r.table_name}.${r.column_name}`),
    app_bypass_policies: policies.rows[0].n,
    public_tables: tables.rows[0].n,
  }, null, 2) + '\n');

  const onlyNames = (v, name) => v.length > 0 && v.every(x => x.includes(name));
  const checks = [
    ['proposed grants', clean, clean.length === 0, 'must be empty'],
    ['+ a new table, as a future migration would create it', futureTable,
      futureTable.length === 1 && /c4a_future_table: no permissive policy admits chronixedu_app/.test(futureTable[0]),
      'exactly one violation, naming the table and the silent zero-row read — and NOT "lacks DML", which proves ALTER DEFAULT PRIVILEGES fired'],
    ['+ that table with its app_bypass policy', futureTableDone, futureTableDone.length === 0, 'the migration that does its job passes'],
    ['+ a new bookkeeping table marked owner-only', futureBookkeeping,
      onlyNames(futureBookkeeping, 'c4a_future_bookkeeping') && futureBookkeeping.some(v => /holds privileges/.test(v)),
      'flagged: default privileges handed it DML, and owner-only must hold nothing'],
    ['+ that table marked AND revoked', futureBookkeepingDone, futureBookkeepingDone.length === 0, 'the deliberate act clears it'],
    ['+ auth.uid() rewritten to reference schema auth', authBody,
      authBody.length === 1 && /auth\.uid\(\) body references schema auth/.test(authBody[0]),
      'the platform dependency is named, not discovered at cutover as failed logins'],
    ['REVOKEs undone (Phase A)', dirty,
      dirty.some(v => /schema_migrations: owner-only/.test(v)) && dirty.some(v => /audit_logs: append-only/.test(v)),
      'the check notices both kinds of loosening'],
  ];

  const all = [...B, ...A];
  const byName = name => ({ A: A.find(x => x.name === name), B: B.find(x => x.name === name) });
  const esc = s => String(s).replace(/\|/g, '\\|');
  const md = [
    '# C-4a privilege probe (generated — `node scripts/c4a/probe.js`)',
    '',
    'Run against a **local rebuild** of `migrations/`, as NOLOGIN roles via `SET LOCAL ROLE`,',
    'each probe in its own rolled-back transaction. **Phase B** is `grants.sql` as proposed;',
    '**Phase A** the same with its REVOKEs undone. Production is PG 17.6, this rebuild PG 16 —',
    'none of the semantics probed changed between them, but the plan requires re-running this',
    'against the real roles before cutover.',
    '',
    `**${all.filter(x => x.pass).length} of ${all.length} probe expectations held; ` +
      `${checks.filter(x => x[2]).length} of ${checks.length} boundary-check expectations held.** ` +
      `${policies.rows[0].n} \`app_bypass_*\` policies for ${tables.rows[0].n} tables (the owner-only ones excluded, by their comment).`,
    '',
    '## Privilege probes',
    '',
    '| Role | Probe | A: without REVOKEs | B: as proposed | Does a REVOKE change it? | Why |',
    '|---|---|---|---|---|---|',
    ...PROBES.map(([role, name, , , why]) => {
      const r = byName(name);
      const cell = x => `${x.pass ? '✅' : '❌'} ${x.got}${x.got.startsWith('ok') ? '' : ` — ${esc(x.detail)}`}`;
      const changes = r.A.got === r.B.got ? 'no' : `**yes** (${r.A.got} → ${r.B.got})`;
      return `| ${role.replace('chronixedu_', '')} | ${name} | ${cell(r.A)} | ${cell(r.B)} | ${changes} | ${why} |`;
    }),
    '',
    '## Boundary check (`scripts/sql/c4a_boundary_check.sql`)',
    '',
    'Derived from `pg_class`, table comments and `has_*_privilege` — no snapshot to',
    'regenerate. An empty result counts only because the rows below show it returning',
    'something when something is wrong.',
    '',
    '| State | Held? | Expected | Violations returned |',
    '|---|---|---|---|',
    ...checks.map(([state, v, ok, expected]) =>
      `| ${state} | ${ok ? '✅' : '❌'} | ${expected} | ${v.length === 0 ? '*(none)*' : v.map(esc).join('<br>')} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs/c4a/probe.md'), md);

  const failedProbes = all.filter(x => !x.pass);
  const failedChecks = checks.filter(x => !x[2]);
  console.log(`probes ${all.length - failedProbes.length}/${all.length}   boundary check ${checks.length - failedChecks.length}/${checks.length}`);
  for (const x of failedProbes) console.log(`  PROBE FAIL [${x.phase}] ${x.name}: wanted ${x.want}, got ${x.got} — ${x.detail}`);
  for (const x of failedChecks) console.log(`  CHECK FAIL ${x[0]}: ${JSON.stringify(x[1])}`);
  process.exit(failedProbes.length || failedChecks.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
