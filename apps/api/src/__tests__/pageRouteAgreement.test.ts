/**
 * A page is never shown to a role the routes it calls refuse (spec docs/superpowers/specs/2026-10-08-roles-permissions-design.md;
 * the reviewer's condition, 8 Oct 2026).
 *
 * Reads every page under apps/web/app/(dashboard), (parent) and (student), finds each call it makes to
 * `/api/schools/${schoolId}/…`, resolves the call to a mounted route (helpers/routeWalk.ts) and that route's
 * capabilities, and fails when a role the page admits holds none of them. Who a page admits is the web's own rule:
 * the dashboard layout's page guard (lib/navigation.ts pageCapability), and the parent and student layouts.
 *
 * A call a page makes only for some of its roles names the capability it is gated on (GATED), and the test checks
 * the gate: every role the page admits without that capability is one the route refuses anyway, every role with it
 * is admitted by the route, and the file names the capability. This is the test that would have caught the four
 * screen faults of 8 Oct 2026: the principal's Students link, the bursar's Settings rail, Fee Settings, Platform Billing.
 *
 * Shared components (apps/web/components) are not read: they call messages, notifications and announcements, which
 * every member may.
 */
import fs from 'fs';
import path from 'path';
import { loadRoutes, type RouteInfo } from './helpers/routeWalk';
import { capabilitiesOf } from '../middleware/requireCapability';
import { pageCapability, mayOpenPage } from '../../../web/lib/navigation';
import { roleHolds, type Capability } from '../../../web/lib/capabilities';

jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: {} }));

const WEB_APP = path.join(__dirname, '../../../web/app');
const AREAS: Array<{ dir: string; capability?: Capability }> = [
  { dir: '(dashboard)' },
  { dir: '(parent)', capability: 'parent.portal' },
  { dir: '(student)', capability: 'student.portal' },
];
const ROLES = ['principal', 'registrar', 'bursar', 'teacher', 'parent', 'student'];
const SAMPLE = '11111111-1111-4111-8111-111111111111';

/** A file that is not a page, with the rule of the pages that use it. */
const SHARED_FILES: Record<string, { capability: Capability; reason: string }> = {
  '(dashboard)/bursar/shared.tsx': { capability: 'fees.manage', reason: 'The term and class pickers of the four fee pages.' },
};

/**
 * A call a page makes only for the roles holding `onlyWhen`, keyed by "<file> <METHOD> <route path>". The file, or
 * the page beside it, must name the capability: the button, tab or card that makes the call is shown on it.
 */
const GATED: Record<string, { onlyWhen: Capability; reason: string }> = {
  // The student list and profile are read by the bursar (students.view); changing a student is students.manage.
  '(dashboard)/registrar/students/page.tsx POST /:schoolId/students': { onlyWhen: 'students.manage', reason: 'Register Student is shown to those who manage students.' },
  '(dashboard)/registrar/students/page.tsx GET /:schoolId/results/class-summary': { onlyWhen: 'results.manage', reason: 'The academic columns are for the principal only.' },
  '(dashboard)/registrar/students/[id]/page.tsx POST /:schoolId/students/:studentId/parents': { onlyWhen: 'students.manage', reason: 'Add Parent / Guardian.' },
  '(dashboard)/registrar/students/[id]/page.tsx PATCH /:schoolId/students/:studentId/class': { onlyWhen: 'students.manage', reason: 'Correct Class.' },
  '(dashboard)/registrar/students/[id]/page.tsx POST /:schoolId/students/:studentId/class': { onlyWhen: 'students.manage', reason: 'Assign Class.' },
  '(dashboard)/registrar/students/[id]/page.tsx PATCH /:schoolId/students/:studentId': { onlyWhen: 'students.manage', reason: 'The details form is read-only otherwise.' },
  '(dashboard)/registrar/students/[id]/page.tsx POST /:schoolId/students/:studentId/photo': { onlyWhen: 'students.manage', reason: 'The photo upload.' },
  '(dashboard)/registrar/students/[id]/page.tsx POST /:schoolId/students/:studentId/transcript': { onlyWhen: 'students.manage', reason: 'The transcript card.' },
  '(dashboard)/registrar/students/[id]/PrincipalRemarkCard.tsx GET /:schoolId/principal-remarks/:studentId': { onlyWhen: 'results.manage', reason: 'The card is for the principal only.' },
  '(dashboard)/registrar/students/[id]/PrincipalRemarkCard.tsx PUT /:schoolId/principal-remarks/:studentId': { onlyWhen: 'results.manage', reason: 'The card is for the principal only.' },
  // Payout Setup: the bursar views, the principal saves ("Only view to avoid changes", Moses, 8 Oct 2026).
  '(dashboard)/settings/payout/page.tsx PUT /:schoolId/settings/payout': { onlyWhen: 'school.payout.manage', reason: 'Save is shown to the principal only.' },
  // Settings -> Roster: the registrar has Classes and Subjects; who teaches what, and form teachers, are the principal's.
  '(dashboard)/settings/roster/page.tsx GET /:schoolId/users': { onlyWhen: 'roster.teaching', reason: 'The teacher list feeds the form teacher and the Teacher Assignments tab.' },
  '(dashboard)/settings/roster/page.tsx POST /:schoolId/teacher-assignments': { onlyWhen: 'roster.teaching', reason: 'Teacher Assignments tab.' },
  '(dashboard)/settings/roster/page.tsx GET /:schoolId/teachers/:teacherId/assignments': { onlyWhen: 'roster.teaching', reason: 'Teacher Assignments tab.' },
  '(dashboard)/settings/roster/page.tsx POST /:schoolId/teacher-assignments/copy-from-term': { onlyWhen: 'roster.teaching', reason: 'Teacher Assignments tab.' },
  '(dashboard)/settings/roster/page.tsx POST /:schoolId/teacher-assignments/bulk': { onlyWhen: 'roster.teaching', reason: 'Teacher Assignments tab.' },
  '(dashboard)/settings/roster/page.tsx DELETE /:schoolId/teacher-assignments/:id': { onlyWhen: 'roster.teaching', reason: 'Teacher Assignments tab.' },
};

/** A call whose address is built so that it cannot be read here, keyed by "<file> <the call as written>". */
const UNREADABLE: Record<string, string> = {};

interface Call { file: string; method: string; written: string; path: string }

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The address a page file serves: its directory, route groups dropped, [param] given a sample. */
function pagePath(file: string, areaDir: string): string {
  const rel = path.relative(path.join(WEB_APP, areaDir), path.dirname(file)).split(path.sep).filter(Boolean);
  return '/' + rel.filter(s => !s.startsWith('(')).map(s => (s.startsWith('[') ? 'x' : s)).join('/');
}

function callsIn(file: string): Call[] {
  const src = fs.readFileSync(file, 'utf8');
  const calls: Call[] = [];
  const re = /`\/api\/schools\/\$\{[^}]+\}([^`]*)`/g;
  const starts = [...src.matchAll(re)];
  starts.forEach((m, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index! : m.index! + 600;
    const after = src.slice(m.index!, Math.min(end, m.index! + 600));
    const before = src.slice(Math.max(0, m.index! - 120), m.index!);
    const declared = /method:\s*'(GET|POST|PUT|PATCH|DELETE)'/.exec(after)?.[1];
    const method = declared ?? (/apiUpload\s*(<[^>]*>)?\(\s*$/.test(before) ? 'POST' : 'GET');
    const written = m[1].split('?')[0];
    calls.push({ file, method, written: m[0], path: written.replace(/\$\{[^}]+\}/g, ':p') });
  });
  return calls;
}

function routesFor(routes: RouteInfo[], call: Call): RouteInfo[] {
  const address = `/${SAMPLE}${call.path.replace(/:p/g, SAMPLE)}`;
  return routes.filter(r => r.prefix === '/api/schools' && r.behindVerify && r.method === call.method && r.regexp.test(address));
}

describe('a page is never shown to a role the routes it calls refuse', () => {
  let routes: RouteInfo[] = [];
  const problems: string[] = [];
  const usedGates = new Set<string>();
  const usedUnreadable = new Set<string>();
  let checked = 0;

  beforeAll(() => {
    routes = loadRoutes();
    for (const area of AREAS) {
      for (const file of filesUnder(path.join(WEB_APP, area.dir))) {
        const rel = path.relative(WEB_APP, file).split(path.sep).join('/');
        const address = pagePath(file, area.dir);
        const fixedCap = area.capability ?? SHARED_FILES[rel]?.capability;
        const pageCap = fixedCap ?? pageCapability(address);
        const calls = callsIn(file);
        if (calls.length === 0) continue;
        if (!pageCap) { problems.push(`${rel}: calls the API but no page rule says who may open it`); continue; }
        // Who the page admits: its area's rule, or the dashboard's page guard itself.
        const admitted = fixedCap ? ROLES.filter(role => roleHolds(role, fixedCap)) : ROLES.filter(role => mayOpenPage(role, address));
        for (const call of calls) {
          const matched = routesFor(routes, call);
          if (matched.length === 0) {
            const key = `${rel} ${call.written}`;
            if (UNREADABLE[key]) { usedUnreadable.add(key); continue; }
            problems.push(`${rel}: ${call.method} ${call.written} matches no route`);
            continue;
          }
          checked++;
          const route = matched[0];
          const caps = route.handles.map(capabilitiesOf).filter((c): c is NonNullable<typeof c> => !!c).flat();
          const refused = admitted.filter(role => !caps.some(c => roleHolds(role, c)));
          if (refused.length === 0) continue;
          const key = `${rel} ${call.method} ${route.path}`;
          const gate = GATED[key];
          if (!gate) {
            problems.push(`${key}: the page admits ${refused.join(', ')}, whom the route refuses (it needs ${caps.join(' or ')})`);
            continue;
          }
          usedGates.add(key);
          const besidePage = path.join(path.dirname(file), 'page.tsx');
          const src = fs.readFileSync(file, 'utf8') + (fs.existsSync(besidePage) ? fs.readFileSync(besidePage, 'utf8') : '');
          const leaks = refused.filter(role => roleHolds(role, gate.onlyWhen));
          const missing = admitted.filter(role => roleHolds(role, gate.onlyWhen) && !caps.some(c => roleHolds(role, c)));
          if (leaks.length > 0 || missing.length > 0) problems.push(`${key}: its gate ${gate.onlyWhen} still lets ${[...leaks, ...missing].join(', ')} through`);
          if (!src.includes(`'${gate.onlyWhen}'`)) problems.push(`${key}: the file never names its gate '${gate.onlyWhen}'`);
        }
      }
    }
  });

  it('control: it reads the pages and resolves their calls', () => {
    expect(checked).toBeGreaterThan(120);
  });

  it('every call is one every role the page admits may make, or is gated on a capability the file checks', () => {
    expect(problems).toEqual([]);
  });

  it('every listed gate and unreadable call is still in use', () => {
    expect(Object.keys(GATED).filter(k => !usedGates.has(k))).toEqual([]);
    expect(Object.keys(UNREADABLE).filter(k => !usedUnreadable.has(k))).toEqual([]);
  });
});
