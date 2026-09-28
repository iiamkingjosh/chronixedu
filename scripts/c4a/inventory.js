#!/usr/bin/env node
/**
 * C-4a inventory generator. Reads the code, never production.
 *
 *   node scripts/c4a/inventory.js
 *
 * Inputs:  apps/api/src (routes, queries, services), docs/c4a/tables.txt (the table list
 *          from a rebuild of migrations/ — regenerate it after any migration).
 * Outputs: docs/c4a/routes.md          every route: method, full path, file:line, guards
 *          docs/c4a/operations.md      every SQL statement: operation, table, file:line, connection
 *          docs/c4a/operations.json    the same, machine-readable, for crosscheck.js
 *
 * This is ONE reader's extraction. It is regex over source, filtered against the real
 * table list, and it will have blind spots — which is exactly why the C-4a plan hands the
 * artifacts to a second reader instead of trusting them. Known limits are listed at the
 * top of each output file, so a reviewer knows where to look hardest.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'apps/api/src');
const OUT = path.join(ROOT, 'docs/c4a');

const TABLES = new Set(
  fs.readFileSync(path.join(OUT, 'tables.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return /__tests__|__db_tests__|node_modules/.test(e.name) ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// ── Routes ───────────────────────────────────────────────────────────────────

function mountMap() {
  const index = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  const varToFile = {};
  for (const m of index.matchAll(/import\s+(\w+)\s+from\s+'\.\/routes\/([\w-]+)'/g)) varToFile[m[1]] = `${m[2]}.ts`;
  const mounts = {}; // file -> [prefix]
  const prefixChain = {}; // prefix -> middleware names mounted with no router
  for (const m of index.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*([^)]*)\)/g)) {
    const prefix = m[1];
    const args = m[2].split(',').map(s => s.trim()).filter(Boolean);
    for (const a of args) {
      if (varToFile[a]) (mounts[varToFile[a]] ??= []).push(prefix);
      else (prefixChain[prefix] ??= []).push(a);
    }
  }
  return { mounts, prefixChain };
}

/** What this file's own requireSchoolAccess admits — they differ per file (doctrine 1). */
function schoolAccessVariant(text) {
  const m = text.match(/function requireSchoolAccess[\s\S]*?\n\}/);
  if (!m) return null;
  const body = m[0];
  const roles = [...body.matchAll(/role\s*===\s*'(\w+)'/g)].map(r => r[1]);
  const extraRoles = roles.filter(r => r !== 'super_admin');
  return extraRoles.length
    ? `restrictive: super_admin, or own-school ${[...new Set(extraRoles)].join('/')}`
    : 'permissive: super_admin, or any user of that school';
}

/**
 * Top-level arguments of a call, starting just after its '('. Skips strings, template
 * literals and comments, tracks nesting, stops at the matching ')'. Null if unbalanced.
 *
 * Replaces a regex that matched lazily up to the next `async (`. A route with a NAMED
 * handler — `router.post('/forgot-password', handleForgotPassword)` — has no `async (`, so
 * the match ran on into the next two registrations: /reset-password and /confirm-reset
 * vanished from the inventory and /forgot-password's guards column held their source text.
 * Caught by comparing against a crude count of `router.<verb>(` calls (196 vs 194).
 */
function splitArgs(text, start) {
  const args = [];
  let depth = 0, cur = '', i = start;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      cur += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { if (cur.trim()) args.push(cur); return args; }
      depth--;
    }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  return null;
}

function routes() {
  const { mounts, prefixChain } = mountMap();
  const rows = [];
  for (const file of fs.readdirSync(path.join(SRC, 'routes')).filter(f => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(SRC, 'routes', file), 'utf8');
    const variant = schoolAccessVariant(text);
    const fileLevel = [...text.matchAll(/router\.use\(([^;]*?)\);/g)].map(m => m[1].trim());
    for (const m of text.matchAll(/router\.(get|post|put|patch|delete)\s*\(/g)) {
      const args = splitArgs(text, m.index + m[0].length);
      if (!args || args.length < 2) continue;
      const pathArg = args[0].trim();
      const lit = /^(['`])([^'`]+)\1$/.exec(pathArg);
      const handler = args[args.length - 1].trim();
      const guards = args.slice(1, -1).map(g => g.replace(/\s+/g, ' ').trim()).filter(Boolean);
      for (const prefix of mounts[file] ?? ['(not mounted in index.ts)']) {
        rows.push({
          method: m[1].toUpperCase(),
          path: lit ? (prefix + lit[2]).replace(/\/+/g, '/') : `${prefix} ⚠ non-literal path: ${pathArg}`,
          file: `apps/api/src/routes/${file}`,
          line: lineOf(text, m.index),
          prefixChain: prefixChain[prefix] ?? [],
          fileLevel,
          guards,
          handler: /^[A-Za-z_$][\w$]*$/.test(handler) ? handler : '(inline)',
          // Top-level registrations start at column 0. An indented one sits inside a
          // block — auth.ts registers /seed-test-user and /test-role only when
          // NODE_ENV !== 'production' && SEED_SECRET — which static extraction cannot
          // evaluate, so it is flagged for the reader rather than silently included.
          conditional: /^[ \t]+$/.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index)),
          schoolAccess: guards.some(g => g.includes('requireSchoolAccess')) ? variant ?? 'imported (not defined in this file)' : null,
        });
      }
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// ── SQL operations ───────────────────────────────────────────────────────────

function connectionFor(file, text, idx) {
  if (file.endsWith('scripts/migrate.ts')) return 'owner (migrate, DATABASE_URL)';
  if (file.endsWith('routes/auth.ts')) {
    const before = text.slice(Math.max(0, idx - 200), idx);
    if (/\bpg\.query\s*\(\s*$/.test(before) || /\bpg\.query\(/.test(before.slice(-40))) return 'login client (routes/auth.ts getPgClient)';
  }
  return 'pool (db/client.ts)';
}

function enclosing(text, idx) {
  const head = text.slice(0, idx);
  const fns = [...head.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(|router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
  const last = fns[fns.length - 1];
  if (!last) return '(module)';
  return last[1] || last[2] || `${last[3].toUpperCase()} ${last[4]}`;
}

function operations() {
  const rows = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const r = rel(file);
    // Template and quoted literals that look like SQL.
    for (const m of text.matchAll(/`([^`]*)`|'((?:[^'\\\n]|\\.)*)'/g)) {
      const sql = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ${expr} ');
      if (!/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i.test(sql)) continue;
      const ops = new Map(); // table -> Set(op)
      const add = (t, op) => { if (TABLES.has(t)) (ops.get(t) ?? ops.set(t, new Set()).get(t)).add(op); };
      for (const x of sql.matchAll(/\bINSERT\s+INTO\s+(\w+)/gi)) {
        add(x[1], 'INSERT');
        if (/ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(sql)) add(x[1], 'UPDATE');
      }
      for (const x of sql.matchAll(/\bUPDATE\s+(\w+)\s+SET\b/gi)) add(x[1], 'UPDATE');
      for (const x of sql.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi)) add(x[1], 'DELETE');
      for (const x of sql.matchAll(/\bTRUNCATE\s+(?:TABLE\s+)?([\w",\s]+)/gi)) for (const t of x[1].split(/[,\s"]+/)) add(t, 'TRUNCATE');
      for (const x of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)) add(x[1], 'SELECT');
      if (ops.size === 0) continue;
      const idx = m.index;
      // For UPDATEs on audit_logs, which columns — the grant is column-level there.
      const auditCols = /\bUPDATE\s+audit_logs\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql);
      for (const [table, set] of ops) {
        rows.push({
          table,
          ops: [...set].sort(),
          file: r,
          line: lineOf(text, idx),
          fn: enclosing(text, idx),
          connection: connectionFor(r, text, idx),
          dynamic: /\$\{expr\}/.test(sql),
          setColumns: table === 'audit_logs' && auditCols
            ? [...auditCols[1].matchAll(/(\w+)\s*=/g)].map(c => c[1])
            : undefined,
        });
      }
    }
  }
  return rows.sort((a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line);
}

// ── Write ────────────────────────────────────────────────────────────────────

const R = routes();
const O = operations();
fs.writeFileSync(path.join(OUT, 'operations.json'), JSON.stringify(O, null, 2) + '\n');

const routeMd = [
  '# Route inventory (generated — `node scripts/c4a/inventory.js`)',
  '',
  `${R.length} routes. Generated from source, not from a running server.`,
  '',
  '**Known limits of this extraction** — look hardest here: routes registered other than',
  'as `router.<method>(\'literal path\', …)` (e.g. a path held in a variable, or `app.get`',
  'directly in index.ts) are not listed; a router mounted by an expression other than a',
  'bare imported name is reported as not mounted. `schoolAccess` reads the definition in',
  'the route\'s own file, because the variants differ (CLAUDE.md doctrine 1).',
  '',
  '*Italic* guards come from the mount in index.ts; `(file)` from a router.use in the',
  'route file; the rest are on the route itself. **— none —** means nothing but the',
  'mount stands between the internet and the handler.',
  '',
  '| Method | Path | Guards | Handler | requireSchoolAccess here | Source |',
  '|---|---|---|---|---|---|',
  ...R.map(r =>
    `| ${r.method} | \`${r.path}\`${r.conditional ? ' ⚠ *conditionally registered — see source*' : ''} | ${[...r.prefixChain.map(p => `*${p}*`), ...r.fileLevel.map(f => `(file) ${f}`), ...r.guards].join(' → ').replace(/\|/g, '\\|') || '**— none —**'} | ${r.handler} | ${r.schoolAccess ?? '—'} | ${r.file}:${r.line} |`
  ),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'routes.md'), routeMd);

const byTable = {};
for (const o of O) (byTable[o.table] ??= []).push(o);
const opsMd = [
  '# Operation inventory (generated — `node scripts/c4a/inventory.js`)',
  '',
  `${O.length} table references across ${new Set(O.map(o => o.file)).size} files; ${Object.keys(byTable).length} of ${TABLES.size} tables are touched by application code.`,
  '',
  '**Known limits** — SQL is found as string literals containing SELECT / INSERT INTO /',
  'UPDATE … SET / DELETE FROM / TRUNCATE, and identifiers are kept only if they are real',
  'tables. Missed: SQL assembled across several separate literals, and table names held in',
  'variables. `SELECT` is recorded for any FROM/JOIN, so a subquery counts. `UPDATE` is',
  'added for `INSERT … ON CONFLICT DO UPDATE`, which needs that privilege.',
  '',
  ...Object.keys(byTable).sort().flatMap(t => [
    `## ${t}`,
    '',
    '| Ops | Where | Function | Connection |',
    '|---|---|---|---|',
    ...byTable[t].map(o =>
      `| ${o.ops.join(', ')}${o.setColumns ? ` (SET ${o.setColumns.join(', ')})` : ''}${o.dynamic ? ' ⚠ dynamic' : ''} | ${o.file}:${o.line} | \`${o.fn}\` | ${o.connection} |`
    ),
    '',
  ]),
  '## Tables no application code touches',
  '',
  ...[...TABLES].filter(t => !byTable[t]).sort().map(t => `- \`${t}\``),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'operations.md'), opsMd);

console.log(`routes: ${R.length}   operations: ${O.length}   tables touched: ${Object.keys(byTable).length}/${TABLES.size}`);
console.log(`unmounted routes: ${R.filter(r => r.path.includes('not mounted')).length}   dynamic SQL references: ${O.filter(o => o.dynamic).length}`);
