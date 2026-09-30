#!/usr/bin/env node
'use strict';
/**
 * The CI security gate: fail on any CRITICAL npm advisory, except the ones named in
 * scripts/audit-allowlist.json — and every exception has to keep earning its place.
 *
 * `npm audit --audit-level=critical` had no way to say "this one, for this reason, until
 * this date", so when next@14.2.35 picked up two critical advisories on 25 Aug 2026 the step
 * went red on every commit, stopped the workflow before lint or any test, and five weeks
 * later carried no signal: a new critical would have looked exactly like the old two. A gate
 * that always fires is indistinguishable from no gate (CLAUDE.md, doctrine 9).
 *
 * An allowlist entry is honoured only while ALL of these hold; each failure is named:
 *   NEW          a critical advisory that is not in the allowlist
 *   STALE        an allowlisted advisory npm no longer reports as critical — remove the
 *                entry, so the list shrinks instead of accumulating
 *   EXPIRED      today is past the entry's `expires` date — re-decide, don't extend by habit
 *   PRECONDITION the configuration fact the entry's reasoning rests on no longer holds
 *   NO REPORT    npm audit did not produce a report at all. Fails closed: a gate that
 *                passes because it could not run is the no-op that looks like success
 *                (doctrine 16).
 *
 * Usage: node scripts/audit-gate.js [--allowlist <file>]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRITICAL = 'critical';

/** Every advisory npm reports, keyed by GHSA id. `via` holds advisory objects and, for a
 *  transitive dependency, plain package names — only the objects are advisories. */
function advisoriesOf(audit) {
  const found = new Map();
  const vulnerabilities = (audit && audit.vulnerabilities) || {};
  for (const [pkg, v] of Object.entries(vulnerabilities)) {
    for (const via of (v && v.via) || []) {
      if (typeof via !== 'object' || !via || !via.url) continue;
      const m = /GHSA-[a-z0-9-]+/i.exec(via.url);
      const id = m ? m[0] : via.url;
      if (!found.has(id)) {
        found.set(id, { id, severity: via.severity, package: via.name || pkg, title: via.title || '' });
      }
    }
  }
  return found;
}

/** Drop // and block comments, so a comment that mentions a setting is not the setting. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * Preconditions are facts about the repository the exception's reasoning depends on, checked
 * mechanically so the day they stop being true is a failed build, not a forgotten assumption.
 * Each returns null when it holds, or a message when it does not.
 */
const PRECONDITIONS = {
  // GHSA-2xp9-vwfh-vxw4 needs an AVIF for the image optimizer to decode. With no remote
  // image source configured an attacker cannot supply one; the only next/image use is a
  // local PNG. The advisory does not itself say remote sources are required — this is an
  // inference from our configuration, which is exactly why it is checked.
  'next-images-local-only': (ctx) => {
    if (ctx.nextConfigText == null) return 'apps/web/next.config.js could not be read, so the claim cannot be checked';
    const hit = /\b(remotePatterns|domains|loader|loaderFile)\b/.exec(stripComments(ctx.nextConfigText));
    return hit ? `apps/web/next.config.js now sets "${hit[1]}", which gives the image optimizer a source an attacker can reach` : null;
  },
};

function evaluate(audit, allowlist, ctx) {
  const failures = [];
  const notes = [];

  if (!audit || typeof audit !== 'object' || audit.error || typeof audit.vulnerabilities !== 'object' || audit.vulnerabilities === null) {
    const why = audit && audit.error ? ` (${audit.error.summary || audit.error.code || 'error'})` : '';
    return { failures: [`NO REPORT: npm audit did not produce a report${why}; the gate cannot pass without one`], notes };
  }
  if (!Array.isArray(allowlist)) {
    return { failures: ['allowlist is not an array'], notes };
  }

  const advisories = advisoriesOf(audit);
  const allowed = new Map(allowlist.filter((e) => e && e.id).map((e) => [e.id, e]));

  for (const adv of advisories.values()) {
    if (adv.severity === CRITICAL && !allowed.has(adv.id)) {
      failures.push(`NEW: ${adv.id} (${adv.package}) — ${adv.title}`);
    }
  }

  allowlist.forEach((entry, i) => {
    if (!entry || !entry.id || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires || '')) {
      failures.push(`MALFORMED: allowlist entry ${i} needs id, reason and expires (YYYY-MM-DD)`);
      return;
    }
    const current = advisories.get(entry.id);
    if (!current || current.severity !== CRITICAL) {
      failures.push(`STALE: ${entry.id} is no longer reported as critical — remove it from the allowlist`);
      return;
    }
    if (ctx.today > entry.expires) {
      failures.push(`EXPIRED: ${entry.id} was allowed until ${entry.expires} — decide again (upgrade, or re-justify with a new date)`);
      return;
    }
    if (entry.precondition) {
      const check = PRECONDITIONS[entry.precondition];
      if (!check) {
        failures.push(`PRECONDITION: ${entry.id} names unknown precondition "${entry.precondition}"`);
        return;
      }
      const broken = check(ctx);
      if (broken) {
        failures.push(`PRECONDITION: ${entry.id} — ${broken}`);
        return;
      }
    }
    notes.push(`allowed until ${entry.expires}: ${entry.id} (${current.package}) — ${entry.reason}`);
  });

  return { failures, notes };
}

function main() {
  const flag = process.argv.indexOf('--allowlist');
  const allowlistPath = flag > -1 ? path.resolve(process.argv[flag + 1]) : path.join(__dirname, 'audit-allowlist.json');
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

  // One fixed string through a shell, rather than (command, args): npm is npm.cmd on Windows,
  // which needs a shell, and Node warns about args combined with a shell. Nothing in it is
  // input.
  const run = spawnSync('npm audit --json', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm exits non-zero whenever it finds ANY vulnerability, so the exit code says nothing
  // here; the report does.
  let audit = null;
  try {
    audit = JSON.parse(run.stdout);
  } catch {
    audit = { error: { summary: 'output was not JSON' } };
  }

  let nextConfigText = null;
  try {
    nextConfigText = fs.readFileSync(path.join(ROOT, 'apps/web/next.config.js'), 'utf8');
  } catch {
    // left null: the precondition check reports it
  }

  const { failures, notes } = evaluate(audit, allowlist, { today: new Date().toISOString().slice(0, 10), nextConfigText });
  for (const n of notes) console.log(`  • ${n}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (failures.length > 0) {
    console.error(`\nSecurity gate FAILED: ${failures.length} problem(s). See scripts/audit-gate.js for what each means.`);
    process.exit(1);
  }
  const total = advisoriesOf(audit);
  const criticals = [...total.values()].filter((a) => a.severity === CRITICAL).length;
  console.log(`\nSecurity gate passed: ${criticals} critical advisory(ies), all on the dated allowlist.`);
}

if (require.main === module) main();

module.exports = { advisoriesOf, evaluate, stripComments, PRECONDITIONS };
