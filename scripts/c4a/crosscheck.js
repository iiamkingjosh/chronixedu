#!/usr/bin/env node
/**
 * C-4a cross-check: what the code does (operations.json) against what the role holds
 * (effective_privileges.json — as Postgres reported it after grants.sql, not as grants.sql
 * describes itself).
 *
 *   node scripts/c4a/inventory.js && PROBE_DATABASE_URL=… node scripts/c4a/probe.js && node scripts/c4a/crosscheck.js
 *
 * One reader's diff. It cannot see SQL the inventory missed — that is what routes.md and
 * a second reader are for, and ultimately what running the suites as the role is for.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const ops = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/c4a/operations.json'), 'utf8'));
const eff = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/c4a/effective_privileges.json'), 'utf8'));

const APP = o => o.connection.startsWith('pool');
const LOGIN = o => o.connection.startsWith('login');
const held = (table, op) => (eff.tables[table] ?? []).includes(op);
// The login role is column-scoped: a statement is covered if the role holds that
// privilege on at least one column of the table. Which columns, exactly, is the boundary
// check's job (c4a_boundary_check.sql compares against POST /login's column list).
const loginHeld = (table, op) => (eff.login_column_privileges ?? []).some(p => p.startsWith(`${op} ${table}.`));

const violations = [];
for (const o of ops.filter(LOGIN)) {
  for (const op of o.ops) if (!loginHeld(o.table, op)) violations.push({ ...o, op });
}
const used = {}; // table -> Set(op) on app connections
for (const o of ops.filter(APP)) {
  for (const op of o.ops) {
    (used[o.table] ??= new Set()).add(op);
    if (held(o.table, op)) continue;
    // Column-level UPDATE on audit_logs: allowed iff every SET column is granted.
    if (o.table === 'audit_logs' && op === 'UPDATE' && o.setColumns &&
        o.setColumns.every(c => eff.audit_logs_update_columns.includes(c))) continue;
    violations.push({ ...o, op });
  }
}

const unused = [];
for (const [table, privs] of Object.entries(eff.tables)) {
  const u = privs.filter(p => !(used[table]?.has(p)));
  if (u.length) unused.push({ table, privs: u });
}

const ownerOnly = ops.filter(o => o.connection.startsWith('owner'));
const dynamic = ops.filter(o => APP(o) && o.dynamic);
const login = ops.filter(LOGIN);

const md = [
  '# C-4a cross-check (generated — `node scripts/c4a/crosscheck.js`)',
  '',
  '`operations.json` (every SQL statement found in `apps/api/src`) against',
  '`effective_privileges.json` (what `information_schema` reports `chronixedu_app` holds',
  'after `grants.sql`, on a local rebuild).',
  '',
  `## 1. Used by the app but NOT granted — ${violations.length}`,
  '',
  violations.length === 0
    ? 'None. Every statement the inventory found on the app pool and the login client is covered by the grant set, including the single `audit_logs` UPDATE (column `processed_at` only, which is exactly the column-level grant).'
    : ['Each of these is a `permission denied` in production the moment `APP_DATABASE_URL` switches:', '',
       '| Table | Op | Where | Function | Connection |', '|---|---|---|---|---|',
       ...violations.map(v => `| ${v.table} | ${v.op} | ${v.file}:${v.line} | \`${v.fn}\` | ${v.connection} |`)].join('\n'),
  '',
  '**This is necessary, not sufficient.** It can only see SQL the inventory found. The',
  `${dynamic.length} app-connection references below are statements assembled with`,
  '`${…}` interpolation — the table was found, but a conditional JOIN or a fragment held in',
  'a variable could hide another. They are the first place a second reader should look.',
  '',
  `## 2. Granted but never used by the app — ${unused.reduce((n, u) => n + u.privs.length, 0)} privileges on ${unused.length} tables`,
  '',
  'Candidates for narrowing after cutover — **not** removed here. The plan is DML-broad on',
  'purpose so the cutover fails on nothing; narrowing is a separate, per-table change, each',
  'one probed like the REVOKEs above.',
  '',
  '| Table | Granted, unused |',
  '|---|---|',
  ...unused.sort((a, b) => a.table.localeCompare(b.table)).map(u => `| ${u.table} | ${u.privs.join(', ')} |`),
  '',
  `## 3. The login connection (routes/auth.ts, POST /login only) — ${login.length} statements`,
  '',
  'Checked above against `chronixedu_login`, its own column-scoped role — not the app role.',
  'It serves the one path reaching the database for an unauthenticated caller, so it holds',
  'only what that path reads and stamps:',
  '',
  ...login.map(o => `- ${o.ops.join(', ')} on \`${o.table}\` — ${o.file}:${o.line}`),
  '',
  `Granted (from information_schema): ${(eff.login_column_privileges ?? []).join('; ')}.`,
  '',
  '`/create-user` and `/seed-test-user` used this client too; they sit behind super_admin',
  'auth / are off in production, and moved to the app pool so the login role needs no',
  'INSERT on users. **TLS:** the client now takes `ssl` from `resolveSsl()` like the pool, and',
  'logs its own `pg_tls_verified` line (`connection: "login"`). It had no `ssl` option at',
  'all, so its TLS was whatever the URL implied while the boot log described the pool only.',
  '',
  `## 4. Owner-only — ${ownerOnly.length} statements`,
  '',
  ...ownerOnly.map(o => `- ${o.ops.join(', ')} on \`${o.table}\` — ${o.file}:${o.line} (${o.connection})`),
  '',
  `## 5. Assembled statements to review by hand — ${dynamic.length}`,
  '',
  '| Table | Ops | Where | Function |',
  '|---|---|---|---|',
  ...dynamic.map(o => `| ${o.table} | ${o.ops.join(', ')} | ${o.file}:${o.line} | \`${o.fn}\` |`),
  '',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'docs/c4a/crosscheck.md'), md);

console.log(`not granted: ${violations.length}   granted-unused: ${unused.reduce((n, u) => n + u.privs.length, 0)} on ${unused.length} tables   login stmts: ${login.length}   owner-only: ${ownerOnly.length}   assembled: ${dynamic.length}`);
process.exit(violations.length ? 1 : 0);
