/**
 * Every school route is decided by the one table (spec docs/superpowers/specs/2026-10-08-roles-permissions-design.md;
 * the reviewer's condition, 8 Oct 2026): a route under /api/schools/:schoolId names its capabilities through exactly
 * one requireCapability, and a file that has moved to it keeps no guard of its own. Routes and roles removed on
 * purpose stay removed, each with the reason it went, so neither comes back as a gap.
 *
 * Routes are read, never run (helpers/routeWalk.ts). Whether each capability admits the right roles at run time
 * is capabilityMatrix.db.test.ts. The files still on their old guards are NOT_YET_MOVED, which only shrinks.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { loadRoutes, routesOf, fullPattern, SRC, type RouteInfo } from './helpers/routeWalk';
import { capabilitiesOf, requireCapability, rolesFor } from '../middleware/requireCapability';

jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: {} }));

/** Files whose routes still use their own guards. Shrinks file by file (Batch 9, tasks 3-9) and ends empty. */
const NOT_YET_MOVED = new Set([
  'routes/parent', 'routes/student', 'routes/assignments',
  'routes/messages', 'routes/announcements', 'routes/notifications',
]);

/** Routes behind the school mount that are not one school's job. Each keeps its own guard. */
const NOT_SCHOOL_JOBS: Record<string, string> = {
  'POST /api/schools/': 'Creates a school: a platform job, platform admin only (requireSuperAdmin).',
};

/** A moved file defines none of these: the table is the only statement of who may call its routes. */
const OLD_GUARDS = [/function requireSchoolAccess\b/, /function requireSchoolMember\b/, /function requirePayoutAccess\b/, /\brequireRole\(/];

interface Removed { file: string; method: string; path: string; role?: string; reason: string }

/**
 * Removed on purpose. Without `role`, the route is gone; with it, that role is no longer admitted. Checked once
 * the file has moved. Re-adding one fails here with the reason it went.
 */
const REMOVED: Removed[] = [
  { file: 'routes/students', method: 'POST', path: '/:schoolId/students/:studentId/promote',
    reason: 'No screen called it; Assign Class and Promotions replace it (spec 2026-10-08).' },
  { file: 'routes/fees', method: 'GET', path: '/:schoolId/fee-invoices/student/:studentId', role: 'student',
    reason: 'Students have no fees page; parents pay. Removed for the student on 8 Oct 2026 so it is not re-added as a gap.' },
  { file: 'routes/fees', method: 'POST', path: '/:schoolId/payments/paystack/initiate', role: 'student',
    reason: 'Parents pay; a student does not start a payment (spec 2026-10-08).' },
  { file: 'routes/assignments', method: 'GET', path: '/:schoolId/assignments', role: 'principal',
    reason: 'No principal screen listed every homework assignment; a role sees what its job uses (8 Oct 2026).' },
];

const isSchoolRoute = (r: RouteInfo) => r.behindVerify && r.prefix === '/api/schools';
const guardsOf = (r: RouteInfo) => r.handles.map(capabilitiesOf).filter((c): c is NonNullable<typeof c> => c !== undefined);

/** What is wrong with these routes and sources, for every file not in `notYetMoved`. Empty when all is well. */
function guardProblems(routes: RouteInfo[], sources: Record<string, string>, notYetMoved: Set<string>): string[] {
  const problems: string[] = [];
  for (const r of routes.filter(isSchoolRoute)) {
    if (notYetMoved.has(r.file)) continue;
    const key = fullPattern(r);
    if (!r.path.startsWith('/:schoolId')) {
      if (!(key in NOT_SCHOOL_JOBS)) problems.push(`${key}: not under /:schoolId, and not listed in NOT_SCHOOL_JOBS`);
      continue;
    }
    const guards = guardsOf(r);
    if (guards.length !== 1) problems.push(`${key}: ${guards.length} requireCapability guards, expected exactly 1`);
  }
  for (const [file, src] of Object.entries(sources)) {
    if (notYetMoved.has(file)) continue;
    for (const re of OLD_GUARDS) if (re.test(src)) problems.push(`${file}: still has ${re}`);
  }
  return problems;
}

function removedProblems(routes: RouteInfo[], notYetMoved: Set<string>, removed: Removed[]): string[] {
  const problems: string[] = [];
  for (const entry of removed) {
    if (notYetMoved.has(entry.file)) continue;
    const r = routes.find(x => x.file === entry.file && x.method === entry.method && x.path === entry.path);
    const what = `${entry.method} ${entry.path}`;
    if (!entry.role) {
      if (r) problems.push(`${what} is mounted again. It was removed because: ${entry.reason}`);
      continue;
    }
    if (!r) { problems.push(`${what} no longer exists: update REMOVED`); continue; }
    if (guardsOf(r).flat().some(cap => rolesFor(cap).includes(entry.role!))) {
      problems.push(`${what} admits the ${entry.role} again. Removed because: ${entry.reason}`);
    }
  }
  return problems;
}

describe('every school route is decided by the table', () => {
  let routes: RouteInfo[] = [];
  let sources: Record<string, string> = {};
  let files: string[] = [];
  beforeAll(() => {
    routes = loadRoutes();
    files = [...new Set(routes.filter(isSchoolRoute).map(r => r.file))].sort();
    sources = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(SRC, `${f}.ts`), 'utf8')]));
  });

  it('control: the walk finds every school router and its routes', () => {
    expect(files).toHaveLength(25);
    expect(routes.filter(isSchoolRoute).length).toBeGreaterThanOrEqual(160);
  });

  it('every moved school route names exactly one requireCapability, and no moved file keeps a guard of its own', () => {
    expect(guardProblems(routes, sources, NOT_YET_MOVED)).toEqual([]);
  });

  it('NOT_YET_MOVED lists only real school routers that still have something to move', () => {
    expect([...NOT_YET_MOVED].filter(f => !files.includes(f))).toEqual([]);
    // A listed file judged as if it had moved must still show a fault; once it shows none, take it off the list.
    for (const file of NOT_YET_MOVED) {
      const own = routes.filter(r => r.file === file);
      expect({ file, stillToMove: guardProblems(own, { [file]: sources[file] }, new Set()).length > 0 })
        .toEqual({ file, stillToMove: true });
    }
  });

  it('routes and roles removed on purpose stay removed', () => {
    expect(removedProblems(routes, NOT_YET_MOVED, REMOVED)).toEqual([]);
  });

  describe('controls: each check fails on the fault it exists for', () => {
    const fake = (build: (r: express.Router) => void, file = 'routes/fake') => {
      const r = express.Router();
      build(r);
      return routesOf(r, { prefix: '/api/schools', name: 'fake', file, behindAppVerify: true });
    };
    const ok = (_req: express.Request, res: express.Response) => { res.end(); };

    it('a route with no guard, or two', () => {
      const none = fake(r => r.get('/:schoolId/x', ok));
      expect(guardProblems(none, {}, new Set())).toEqual(['GET /api/schools/:schoolId/x: 0 requireCapability guards, expected exactly 1']);
      const two = fake(r => r.get('/:schoolId/x', requireCapability('fees.manage'), requireCapability('school.member'), ok));
      expect(guardProblems(two, {}, new Set())).toHaveLength(1);
      const one = fake(r => r.get('/:schoolId/x', requireCapability('fees.manage'), ok));
      expect(guardProblems(one, {}, new Set())).toEqual([]);
    });

    it('a moved file that keeps its own guard, and a route outside /:schoolId', () => {
      expect(guardProblems([], { 'routes/fake': 'router.get(x, requireRole(\'bursar\'), h)' }, new Set())).toHaveLength(1);
      expect(guardProblems([], { 'routes/fake': 'function requireSchoolAccess(req, res, next) {}' }, new Set())).toHaveLength(1);
      expect(guardProblems(fake(r => r.get('/loose', ok)), {}, new Set())).toHaveLength(1);
    });

    it('a removed route mounted again, and a removed role admitted again', () => {
      const back = fake(r => r.post('/:schoolId/students/:studentId/promote', requireCapability('students.manage'), ok), 'routes/students');
      expect(removedProblems(back, new Set(), [REMOVED[0]])).toEqual([expect.stringContaining('mounted again')]);
      const student = fake(r => r.get('/:schoolId/fee-invoices/student/:studentId', requireCapability('fees.manage', 'student.portal'), ok), 'routes/fees');
      expect(removedProblems(student, new Set(), [REMOVED[1]])).toEqual([expect.stringContaining('admits the student again')]);
      const fixed = fake(r => r.get('/:schoolId/fee-invoices/student/:studentId', requireCapability('fees.manage', 'parent.portal'), ok), 'routes/fees');
      expect(removedProblems(fixed, new Set(), [REMOVED[1]])).toEqual([]);
    });
  });
});
