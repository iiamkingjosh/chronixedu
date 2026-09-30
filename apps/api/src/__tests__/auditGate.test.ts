/**
 * scripts/audit-gate.js — the CI security gate with a dated, machine-checked exception list.
 *
 * Doctrine 16 throughout: "the gate passes" is also what a gate that checks nothing does.
 * So every pass is preceded by the same inputs failing without the exception, and every
 * failure test uses an input that passes once the one thing under test is put right.
 */
import fs from 'fs';
import path from 'path';
import { evaluate, stripComments } from '../../../../scripts/audit-gate';

const ROOT = path.join(__dirname, '../../../..');
const TODAY = '2026-10-01';

interface Adv { id: string; severity: string; pkg?: string }

/** The shape `npm audit --json` uses: advisory objects in `via`, package names for transitives. */
function auditWith(advs: Adv[]) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const a of advs) {
    const pkg = a.pkg ?? 'next';
    const node = (vulnerabilities[pkg] ??= { name: pkg, severity: a.severity, via: [] as unknown[] }) as { via: unknown[] };
    node.via.push({ source: 1, name: pkg, title: `title of ${a.id}`, url: `https://github.com/advisories/${a.id}`, severity: a.severity, range: '<1' });
  }
  vulnerabilities['some-transitive'] = { name: 'some-transitive', severity: 'high', via: ['next'] }; // names, not advisories
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

const WINDOWS = 'GHSA-aaaa-bbbb-cccc';
const AVIF = 'GHSA-dddd-eeee-ffff';
const OK_CONFIG = `const withPWA = require('x'); module.exports = withPWA({ reactStrictMode: true });`;
const ctx = (over: Partial<{ today: string; nextConfigText: string | null }> = {}) => ({ today: TODAY, nextConfigText: OK_CONFIG, ...over });

const allowlist = [
  { id: WINDOWS, package: 'next', reason: 'Windows hosts only', precondition: null, expires: '2026-12-31' },
  { id: AVIF, package: 'next', reason: 'no attacker-supplied image', precondition: 'next-images-local-only', expires: '2026-12-31' },
];
const both = auditWith([{ id: WINDOWS, severity: 'critical' }, { id: AVIF, severity: 'critical' }]);

describe('the gate passes only what the allowlist honestly covers', () => {
  it('the same two critical advisories FAIL with an empty allowlist, and pass with it', () => {
    const without = evaluate(both, [], ctx());
    expect(without.failures.filter((f) => f.startsWith('NEW:'))).toHaveLength(2); // the precondition
    const withList = evaluate(both, allowlist, ctx());
    expect(withList.failures).toEqual([]);
    expect(withList.notes).toHaveLength(2);
  });

  it('fails on a NEW critical advisory that is not allowlisted', () => {
    const audit = auditWith([{ id: WINDOWS, severity: 'critical' }, { id: AVIF, severity: 'critical' }, { id: 'GHSA-zzzz-zzzz-zzzz', severity: 'critical', pkg: 'express' }]);
    const r = evaluate(audit, allowlist, ctx());
    expect(r.failures).toEqual([expect.stringContaining('NEW: GHSA-zzzz-zzzz-zzzz (express)')]);
  });

  it('ignores advisories below critical — the gate is for critical only', () => {
    const audit = auditWith([{ id: WINDOWS, severity: 'critical' }, { id: AVIF, severity: 'critical' }, { id: 'GHSA-high-high-high', severity: 'high' }]);
    expect(evaluate(audit, allowlist, ctx()).failures).toEqual([]);
  });
});

describe('an exception has to keep earning its place', () => {
  it('fails STALE when an allowlisted advisory is no longer reported — so the list shrinks', () => {
    expect(evaluate(both, allowlist, ctx()).failures).toEqual([]); // fine until the advisory goes away
    const fixed = auditWith([{ id: WINDOWS, severity: 'critical' }]); // next was upgraded; AVIF is gone
    const r = evaluate(fixed, allowlist, ctx());
    expect(r.failures).toEqual([expect.stringContaining(`STALE: ${AVIF}`)]);
  });

  it('fails STALE when the advisory is still reported but no longer critical', () => {
    const downgraded = auditWith([{ id: WINDOWS, severity: 'critical' }, { id: AVIF, severity: 'high' }]);
    expect(evaluate(downgraded, allowlist, ctx()).failures).toEqual([expect.stringContaining(`STALE: ${AVIF}`)]);
  });

  it('fails EXPIRED the day after the date, and passes ON the date', () => {
    expect(evaluate(both, allowlist, ctx({ today: '2026-12-31' })).failures).toEqual([]); // the last day
    const r = evaluate(both, allowlist, ctx({ today: '2027-01-01' }));
    expect(r.failures).toHaveLength(2);
    expect(r.failures.every((f) => f.startsWith('EXPIRED:'))).toBe(true);
  });

  it('fails PRECONDITION when next.config.js gains a remote image source', () => {
    expect(evaluate(both, allowlist, ctx()).failures).toEqual([]); // fine as it stands
    for (const setting of ['remotePatterns: [{ hostname: "x.supabase.co" }]', 'domains: ["cdn.example.com"]', 'loader: "custom"', 'loaderFile: "./l.js"']) {
      const text = `module.exports = { images: { ${setting} } };`;
      const r = evaluate(both, allowlist, ctx({ nextConfigText: text }));
      expect(r.failures).toEqual([expect.stringContaining(`PRECONDITION: ${AVIF}`)]);
    }
  });

  it('a comment that merely mentions the setting does not trip the precondition', () => {
    const text = `// no remotePatterns or domains here, on purpose\n/* loader: none */\nmodule.exports = {};`;
    expect(evaluate(both, allowlist, ctx({ nextConfigText: text })).failures).toEqual([]);
    expect(stripComments('a // b\nc /* d */ e')).toBe('a \nc  e');
  });

  it('fails PRECONDITION when next.config.js cannot be read — an unverifiable claim is not a verified one', () => {
    expect(evaluate(both, allowlist, ctx({ nextConfigText: null })).failures).toEqual([expect.stringContaining('could not be read')]);
  });

  it('fails on a precondition name it does not know, rather than skipping it', () => {
    const typo = [allowlist[0], { ...allowlist[1], precondition: 'next-images-local-onyl' }];
    expect(evaluate(both, typo, ctx()).failures).toEqual([expect.stringContaining('unknown precondition')]);
  });

  it('fails MALFORMED on an entry with no expiry — an exception must have a date', () => {
    const noDate = Object.fromEntries(Object.entries(allowlist[0]).filter(([k]) => k !== 'expires'));
    const r = evaluate(both, [noDate, allowlist[1]], ctx());
    expect(r.failures.some((f) => f.startsWith('MALFORMED:'))).toBe(true);
  });
});

describe('the gate fails closed when it cannot see', () => {
  it('passes a clean report with an empty allowlist — so the failures below are not a gate that always fails', () => {
    const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
    expect(evaluate(clean, [], ctx())).toEqual({ failures: [], notes: [] });
  });

  it('fails NO REPORT when npm audit returned an error (registry unreachable)', () => {
    const r = evaluate({ error: { code: 'ENOTFOUND', summary: 'request to registry failed' } }, allowlist, ctx());
    expect(r.failures).toEqual([expect.stringContaining('NO REPORT')]);
  });

  it('fails NO REPORT on output that is not a report at all', () => {
    for (const junk of [null, undefined, 'text', {}, { vulnerabilities: null }]) {
      expect(evaluate(junk, allowlist, ctx()).failures).toEqual([expect.stringContaining('NO REPORT')]);
    }
  });
});

describe("this repository's actual exception list", () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/audit-allowlist.json'), 'utf8')) as Array<Record<string, unknown>>;
  const nextConfig = fs.readFileSync(path.join(ROOT, 'apps/web/next.config.js'), 'utf8');

  it('names the two Next advisories, each with a reason and a date', () => {
    expect(real.map((e) => e.id).sort()).toEqual(['GHSA-2xp9-vwfh-vxw4', 'GHSA-p293-qw3h-jr36']);
    for (const e of real) {
      expect(typeof e.reason).toBe('string');
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('holds its precondition today: next.config.js gives the image optimizer no remote source', () => {
    const audit = auditWith(real.map((e) => ({ id: e.id as string, severity: 'critical' })));
    const r = evaluate(audit, real, ctx({ nextConfigText: nextConfig, today: '2026-10-01' }));
    expect(r.failures).toEqual([]);
    expect(r.notes).toHaveLength(2); // both evaluated and honoured, not skipped
  });
});
