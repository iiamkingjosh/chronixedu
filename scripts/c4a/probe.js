#!/usr/bin/env node
/**
 * C-4a privilege probe — LOCAL REBUILD ONLY. Refuses any host but localhost.
 *
 *   PROBE_DATABASE_URL=postgres://postgres:postgres@localhost:5470/chronixedu_test node scripts/c4a/probe.js
 *
 * The plan's rule: prove each denial by attempting it as the role, on the grant set you
 * intend to ship, before trusting any REVOKE. So this runs every probe twice:
 *
 *   Phase B — docs/c4a/grants.sql exactly as proposed.
 *   Phase A — the same, with its REVOKEs undone.
 *
 * A REVOKE earns its place only if some probe differs between the phases. Every probe
 * that is expected to SUCCEED also checks rows affected — an UPDATE that matched nothing
 * raises no error either (doctrine 16).
 *
 * Writes docs/c4a/probe.md and docs/c4a/effective_privileges.json (as Postgres reports
 * them, for crosscheck.js — not re-described from grants.sql).
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
const UNDO_REVOKES = `
  GRANT SELECT, INSERT, UPDATE, DELETE ON schema_migrations, migration_runs TO chronixedu_app;
  GRANT UPDATE, DELETE ON audit_logs TO chronixedu_app;`;

const SCHOOL = 'c4a00000-0000-4000-8000-000000000001';

/** name, sql, expectation per phase: 'ok' | 'denied' | 'trigger' | 'error' */
const PROBES = [
  ['TRUNCATE a tenant table', `TRUNCATE notices`, { A: 'denied', B: 'denied' },
    'Never granted — DML only. The plan expected ALL to include TRUNCATE; with DML-only it is absent by construction.'],
  ['CREATE TABLE in public', `CREATE TABLE c4a_probe_table (id int)`, { A: 'denied', B: 'denied' },
    'PG15+ gives PUBLIC no CREATE on public, and USAGE is not CREATE. No revoke needed; none written.'],
  ['ALTER TABLE audit_logs DISABLE TRIGGER ALL', `ALTER TABLE audit_logs DISABLE TRIGGER ALL`, { A: 'denied', B: 'denied' },
    'Owner-only. Doctrine 6 lists this as a way past the append-only triggers — for the owner. Not for the app role.'],
  ['SET session_replication_role = replica', `SET LOCAL session_replication_role = replica`, { A: 'denied', B: 'denied' },
    'Superuser-only. The other escape hatch doctrine 6 names; closed to the app role.'],
  ['DELETE FROM audit_logs', `DELETE FROM audit_logs WHERE school_id = '${SCHOOL}'`, { A: 'trigger', B: 'denied' },
    'A: privilege allows it and the 036 trigger stops it. B: refused before the trigger is reached. The REVOKE moves enforcement a layer earlier.'],
  ['UPDATE audit_logs content column', `UPDATE audit_logs SET action_type = 'TAMPERED' WHERE school_id = '${SCHOOL}'`, { A: 'trigger', B: 'denied' },
    'Same shape as DELETE.'],
  ['UPDATE audit_logs SET processed_at (the worker)', `UPDATE audit_logs SET processed_at = now() WHERE school_id = '${SCHOOL}' AND processed_at IS NULL`, { A: 'ok:1', B: 'ok:1' },
    'MUST still work: this is the notification queue marker. Revoking UPDATE wholesale would have been migration 036 again.'],
  ['INSERT INTO audit_logs', `INSERT INTO audit_logs (school_id, action_type, entity) VALUES ('${SCHOOL}', 'C4A_PROBE', 'probe')`, { A: 'ok:1', B: 'ok:1' },
    'Every sensitive write audits (doctrine 10).'],
  ['SELECT schema_migrations', `SELECT count(*) FROM schema_migrations`, { A: 'ok', B: 'denied' },
    'Owner bookkeeping. Only src/scripts/migrate.ts touches it, on the owner connection.'],
  ['SELECT migration_runs', `SELECT count(*) FROM migration_runs`, { A: 'ok', B: 'denied' }, 'As above.'],
  ['Read a tenant table through RLS', `SELECT count(*)::int AS n FROM schools WHERE id = '${SCHOOL}'`, { A: 'ok:rows=1', B: 'ok:rows=1' },
    'RLS switches on for a non-owner; without app_bypass_schools this returns 0 rows, silently. Asserting 1 proves the bypass policy works.'],
  ['Ordinary DML: UPDATE a tenant row', `UPDATE schools SET name = name WHERE id = '${SCHOOL}'`, { A: 'ok:1', B: 'ok:1' },
    'WITH CHECK (true) on the bypass policy; the row must be visible AND writable.'],
];

function classify(err) {
  if (!err) return 'ok';
  if (/permission denied|must be owner|must be superuser|not permitted to set parameter/i.test(err.message)) return 'denied';
  if (/append-only|audit_logs is append/i.test(err.message)) return 'trigger';
  return 'error';
}

async function runProbes(c, phase) {
  const out = [];
  for (const [name, sql, expect, why] of PROBES) {
    let got, detail = '';
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE chronixedu_app');
    try {
      const r = await c.query(sql);
      got = 'ok';
      if (/^\s*SELECT count\(\*\)::int AS n/.test(sql)) { got = `ok:rows=${r.rows[0].n}`; }
      else if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) { got = `ok:${r.rowCount}`; }
      detail = got;
    } catch (err) {
      got = classify(err);
      detail = err.message.split('\n')[0];
    }
    await c.query('ROLLBACK');
    const want = expect[phase];
    out.push({ phase, name, want, got, pass: got === want || (want === 'ok' && got.startsWith('ok')), detail, why });
  }
  return out;
}

(async () => {
  const c = new Client({ connectionString: URL_ });
  await c.connect();

  // Fixtures, as owner. A dormant school (039 allows that at INSERT) and one unprocessed
  // audit row, so every UPDATE/DELETE probe has a row to hit — a probe against an empty
  // table proves nothing.
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chronixedu_app') THEN CREATE ROLE chronixedu_app NOLOGIN; END IF; END $$`);
  await c.query(`INSERT INTO schools (id, name, slug) VALUES ($1, 'C4A Probe School', 'c4a-probe') ON CONFLICT (id) DO NOTHING`, [SCHOOL]);
  await c.query(`INSERT INTO audit_logs (school_id, action_type, entity) VALUES ($1, 'C4A_FIXTURE', 'probe')`, [SCHOOL]);

  await c.query(GRANTS);
  const B = await runProbes(c, 'B');

  const privs = await c.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'chronixedu_app' AND table_schema = 'public' ORDER BY 1, 2`);
  const colPrivs = await c.query(
    `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
      WHERE grantee = 'chronixedu_app' AND table_schema = 'public' AND table_name = 'audit_logs'
        AND privilege_type = 'UPDATE' ORDER BY 1, 2`);
  const policies = await c.query(
    `SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'app_bypass_%'`);
  const tables = await c.query(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`);

  await c.query(UNDO_REVOKES);
  const A = await runProbes(c, 'A');
  await c.end();

  const eff = {};
  for (const r of privs.rows) (eff[r.table_name] ??= []).push(r.privilege_type);
  fs.writeFileSync(path.join(ROOT, 'docs/c4a/effective_privileges.json'), JSON.stringify({
    source: 'information_schema, after applying docs/c4a/grants.sql to a local rebuild (Phase B)',
    tables: eff,
    audit_logs_update_columns: colPrivs.rows.map(r => r.column_name),
    app_bypass_policies: policies.rows[0].n,
    public_tables: tables.rows[0].n,
  }, null, 2) + '\n');

  const all = [...B, ...A];
  const byName = name => ({ A: A.find(x => x.name === name), B: B.find(x => x.name === name) });
  const md = [
    '# C-4a privilege probe (generated — `node scripts/c4a/probe.js`)',
    '',
    'Run against a **local rebuild** of `migrations/`, as a NOLOGIN `chronixedu_app` role via',
    '`SET LOCAL ROLE`, each probe in its own rolled-back transaction. **Phase B** is',
    '`grants.sql` as proposed; **Phase A** is the same with its REVOKEs undone. A REVOKE is',
    'justified only where the phases differ. Production is PG 17.6, this rebuild PG 16 — the',
    'semantics probed here did not change between them, but the plan requires re-running this',
    'against the real role before cutover.',
    '',
    `**${all.filter(x => x.pass).length} of ${all.length} expectations held.** ` +
      `${policies.rows[0].n} \`app_bypass_*\` policies for ${tables.rows[0].n} tables (bookkeeping tables excluded by design).`,
    '',
    '| Probe | A: without REVOKEs | B: as proposed | Does a REVOKE change it? | Why |',
    '|---|---|---|---|---|',
    ...PROBES.map(([name, , , why]) => {
      const r = byName(name);
      const cell = x => `${x.pass ? '✅' : '❌'} ${x.got}${x.got.startsWith('ok') ? '' : ` — ${x.detail.replace(/\|/g, '\\|')}`}`;
      const changes = r.A.got === r.B.got ? 'no' : `**yes** (${r.A.got} → ${r.B.got})`;
      return `| ${name} | ${cell(r.A)} | ${cell(r.B)} | ${changes} | ${why} |`;
    }),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs/c4a/probe.md'), md);

  console.log(`${all.filter(x => x.pass).length}/${all.length} expectations held`);
  for (const x of all.filter(x => !x.pass)) console.log(`  FAIL [${x.phase}] ${x.name}: wanted ${x.want}, got ${x.got} — ${x.detail}`);
  process.exit(all.every(x => x.pass) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
