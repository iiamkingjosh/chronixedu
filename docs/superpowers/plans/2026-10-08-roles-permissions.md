# One table of who can do what — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every school route, the dashboard sidebar, the Settings rail and the Ctrl+K palette decide "may this role do
this job" from one table, and tests fail when any of them disagree with it or a route escapes it.

**Architecture:** `apps/api/src/config/capabilities.json` (capability → roles, plus whether a platform admin holds
it) is the only statement of who does what. The API reads it through one guard, `requireCapability(...)`, which
replaces the 25 per-file `requireSchoolAccess` copies and every `requireRole` on a school route. The web reads an
exact copy through `lib/navigation.ts`. Record-level rules (a teacher's own classes, a parent's own children) stay
in the route handlers.

**Tech Stack:** Express + TypeScript, Jest (unit, DB, integration), Next.js 14.

**Spec:** `docs/superpowers/specs/2026-10-08-roles-permissions-design.md`. Route-by-route mapping:
`docs/superpowers/plans/2026-10-08-roles-permissions-routes.md` (163 routes, today's roles, the capability each moves
to). Both travel with this plan.

## Decisions this plan carries

From the spec (Moses, 8 Oct 2026), and the answers relayed with the reviewer's agreement on 8 Oct 2026:

1. **The principal has everything the bursar has**, fee lines and invoice generation included, and everything the
   registrar has. It is an invariant on the table (Task 1), not a list of routes, so a new fee route cannot default
   to bursar-only. Refunds by the principal reverse CLAUDE.md's 6 Oct "Bursar only (not the principal)".
2. **A student no longer reads fee invoices** (`GET /fee-invoices/student/:studentId` drops the student). No student
   screen used it; parents pay. Recorded as a removal with its reason (Task 2's ratchet), so it is not re-added as a gap.
3. **Changing a staff member's email stays with the platform admin.** The email is the account's only key, and a
   password reset goes there: a principal who could change it could take the account. Its own capability,
   `staff.email`, with no school role, pinned by a test that says why.
4. **The four open reads close:** a teacher's assignment list (principal; a teacher their own), the assessment
   structure, twice (principal), a teacher's pending scores (principal; a teacher their own).
5. **The principal no longer lists every homework assignment** (`GET /assignments`). No screen used it. Recorded as a
   removal with its reason.
6. **Fees in the principal's sidebar:** a Fees group linking the bursar's pages, with no label colliding.
7. Already decided: the bursar views Payout Setup and only the principal saves it ("Only view to avoid changes");
   a teacher sees only the students of classes they teach or form-teach; the parent, student and teacher-workspace
   portals are not a platform admin's (they reach a school through a support session as one of its users).

**Decided (8 Oct 2026): a registrar does not set a class's form teacher.** The field grants rights (the class's
attendance and comments), so setting it is a permissions action, and granting rights is the principal's. The
registrar's class form has no form-teacher field, and the API refuses a registrar's change to it while keeping the
existing value when a registrar edits a class.

## Global Constraints

- Tenant id comes from the verified JWT, never the request (CLAUDE.md doctrine 1). The guard compares
  `req.user.school_id` with `req.params.schoolId`; a platform admin passes only where the row says
  `"platform_admin": true`.
- Refusals keep today's shape: 401 `UNAUTHORIZED` with no user, 403 `FORBIDDEN` otherwise.
- Every route keeps exactly the roles it admits today unless a decision above says otherwise. Each change is
  listed in the appendix and lands in the task that moves its route, with a DB test that fails on the old code.
- `platform_admin` is stated on every row, never defaulted (doctrine 8).
- No route outside `/:schoolId` changes: platform-admin routes, partner routes, sign-in, Paystack's webhooks and
  `POST /api/schools` keep their own guards.
- Lint ratchet stays (api 1, web 3); never raised.
- Each task is one local commit with its tests; nothing is pushed without Moses's go.

## Review Focus

- A support-session token (a platform admin acting as a school user) carries that user's role: the guard must judge
  the token's role, never fall back to "super_admin passes".
- A route with two jobs (a staff read that parents also use: report card, receipt, a student's attendance) names
  every capability it serves, and the record check stays in the handler. Test both: a parent of another child is
  still refused.
- A teacher's class check (decision 7) on reads that had none: a teacher who teaches the class is admitted, one who
  does not is refused, and a form teacher counts as teaching it.
- The registrar on Settings → Roster: the Classes tab must load without the principal-only staff list.
- A page reached by typing its address (no sidebar link): the dashboard layout refuses it from the same table.

---

### Task 1: The table, the guard, and the table's own tests

**Files:**
- Create: `apps/api/src/config/capabilities.json`, `apps/web/lib/capabilities.json` (identical copy)
- Create: `apps/api/src/middleware/requireCapability.ts`
- Test: `apps/api/src/__tests__/capabilities.test.ts`

**Interfaces:**
- Produces: `requireCapability(...caps: Capability[])`, `type Capability`, `capabilitiesOf(handler): Capability[] | undefined`
  (for the route walker), `rolesFor(cap)`.

- [ ] **Step 1: The table**

```json
{
  "roles": ["principal", "registrar", "bursar", "teacher", "parent", "student"],
  "capabilities": {
    "school.setup":            { "roles": ["principal"], "platform_admin": true },
    "school.export":           { "roles": ["principal"], "platform_admin": true },
    "staff.manage":            { "roles": ["principal"], "platform_admin": true },
    "staff.email":             { "roles": [], "platform_admin": true },
    "roster.classes_subjects": { "roles": ["principal", "registrar"], "platform_admin": true },
    "roster.teaching":         { "roles": ["principal"], "platform_admin": true },
    "timetable.manage":        { "roles": ["principal"], "platform_admin": true },
    "students.manage":         { "roles": ["principal", "registrar"], "platform_admin": true },
    "students.view":           { "roles": ["principal", "registrar", "bursar"], "platform_admin": true },
    "results.enter":           { "roles": ["principal", "teacher"], "platform_admin": true },
    "results.manage":          { "roles": ["principal"], "platform_admin": true },
    "class.daily":             { "roles": ["principal", "teacher"], "platform_admin": true },
    "class.comments":          { "roles": ["principal", "teacher"], "platform_admin": true },
    "school.overview":         { "roles": ["principal"], "platform_admin": true },
    "teacher.workspace":       { "roles": ["teacher"], "platform_admin": false },
    "announcements.post":      { "roles": ["principal"], "platform_admin": true },
    "fees.manage":             { "roles": ["principal", "bursar"], "platform_admin": true },
    "school.payout.view":      { "roles": ["principal", "bursar"], "platform_admin": true },
    "school.payout.manage":    { "roles": ["principal"], "platform_admin": true },
    "school.billing":          { "roles": ["principal", "bursar"], "platform_admin": true },
    "parent.portal":           { "roles": ["parent"], "platform_admin": false },
    "student.portal":          { "roles": ["student"], "platform_admin": false },
    "school.member":           { "roles": ["principal", "registrar", "bursar", "teacher", "parent", "student"], "platform_admin": true }
  }
}
```

`parent.portal` is `platform_admin: false` although parent.ts admits a platform admin today; no platform screen
calls those routes, and a platform admin sees a parent's view through a support session. Listed in the appendix as a
change. `teacher.workspace` and `student.portal` already refuse a platform admin.

- [ ] **Step 2: The table's tests (write, run, see them fail before the guard exists)**

```ts
/**
 * The table is the only statement of who does what (spec 2026-10-08). These pin its shape and the rules Moses
 * stated, so a change to either is a decision someone makes, not a drift.
 */
import fs from 'fs';
import path from 'path';
import table from '../config/capabilities.json';

const caps = table.capabilities as Record<string, { roles: string[]; platform_admin: boolean }>;
const holds = (role: string) => Object.keys(caps).filter((c) => caps[c].roles.includes(role));

it('the web copy is identical (refresh it with scripts/sync-capabilities.js)', () => {
  const web = fs.readFileSync(path.join(__dirname, '../../../web/lib/capabilities.json'), 'utf8');
  expect(JSON.parse(web)).toEqual(table);
});

it('every row names only real roles, and states platform_admin', () => {
  for (const [cap, row] of Object.entries(caps)) {
    expect({ cap, unknown: row.roles.filter((r) => !table.roles.includes(r)) }).toEqual({ cap, unknown: [] });
    expect({ cap, stated: typeof row.platform_admin }).toEqual({ cap, stated: 'boolean' });
  }
});

it('the principal has everything the bursar has, and everything the registrar has (Moses, 8 Oct 2026)', () => {
  expect(holds('bursar').length).toBeGreaterThan(0);
  expect(holds('registrar').length).toBeGreaterThan(0);
  expect(holds('bursar').filter((c) => !caps[c].roles.includes('principal'))).toEqual([]);
  expect(holds('registrar').filter((c) => !caps[c].roles.includes('principal'))).toEqual([]);
});

it("a staff member's email is changed by the platform admin only: it is the account's only key", () => {
  // A password reset goes to this address, so whoever can change it can take the account (8 Oct 2026).
  expect(caps['staff.email']).toEqual({ roles: [], platform_admin: true });
});

it('the bursar views Payout Setup and only the principal saves it ("Only view to avoid changes")', () => {
  expect(caps['school.payout.view'].roles).toContain('bursar');
  expect(caps['school.payout.manage'].roles).toEqual(['principal']);
});
```

Run: `cd apps/api && npx jest -c jest.unit.config.js capabilities` — Expected: FAIL (no table yet), then PASS after Step 1
and the web copy.

- [ ] **Step 3: The guard**

```ts
import { Request, Response, NextFunction, RequestHandler } from 'express';
import table from '../config/capabilities.json';

export type Capability = keyof typeof table.capabilities;
const rows = table.capabilities as Record<Capability, { roles: string[]; platform_admin: boolean }>;
const marked = new WeakMap<RequestHandler, Capability[]>();

/**
 * The one guard on a school route (spec 2026-10-08): the caller's school, then a role that holds any of the named
 * capabilities. A platform admin passes only where the row says platform_admin. A support-session token carries the
 * school user's role and is judged as that role. Which records the caller may touch stays in the handler.
 */
export function requireCapability(...caps: Capability[]): RequestHandler {
  if (caps.length === 0) throw new Error('requireCapability needs at least one capability');
  const guard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return void res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    const platform = user.role === 'super_admin';
    if (!platform && user.school_id !== req.params.schoolId) {
      return void res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    const ok = caps.some((c) => (platform ? rows[c].platform_admin : rows[c].roles.includes(user.role)));
    if (!ok) return void res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    next();
  };
  marked.set(guard, caps);
  return guard;
}

/** The capabilities a guard names, for the route walker; undefined for any other handler. */
export function capabilitiesOf(handler: unknown): Capability[] | undefined {
  return typeof handler === 'function' ? marked.get(handler as RequestHandler) : undefined;
}
```

- [ ] **Step 4: Guard tests** in the same file: no user → 401; another school → 403; a holder → next; a non-holder → 403;
  a platform admin → next where `platform_admin` is true and 403 where false; several capabilities admit on any one;
  `capabilitiesOf` returns what was named and undefined for a plain function. Each refusal is shown beside an
  admission for the same route (doctrine 16).

- [ ] **Step 5:** `scripts/sync-capabilities.js` copies the API table to the web. Run lint, `tsc` both, unit. Commit.

### Task 2: The route walker and the removals ratchet

**Files:** Test: `apps/api/src/__tests__/capabilityRoutes.test.ts` (reuses the router walk in
`twoFactorSetupRoutes.test.ts`, moved to `src/__tests__/helpers/routeWalk.ts` so both share it).

- [ ] **Step 1:** Walk every router `index.ts` mounts under `/api/schools` behind `verifyToken`. For each route under
  `/:schoolId`, collect `capabilitiesOf` over its stack. Fail when a route of a MOVED file has no `requireCapability`,
  has more than one, still has `requireRole`, or its file still defines `requireSchoolAccess`. `NOT_YET_MOVED` lists the
  files still on the old guards; the test fails if a listed file has been fully moved (so the list only shrinks), and
  Task 12 asserts it is empty.
- [ ] **Step 2: Removed on purpose.** `REMOVED_ROUTES`, each with its reason, fails if the method and path are mounted
  again:

```ts
const REMOVED_ROUTES = [
  { route: 'GET /:schoolId/fee-invoices/student/:studentId (for a student)', reason: 'Students have no fees page; parents pay (8 Oct 2026). The route stays for staff and parents; the student role is refused, tested in feesAccess.db.test.ts.' },
  { route: 'GET /:schoolId/assignments (for a principal)', reason: 'No principal screen listed homework; a principal sees only what their job uses (8 Oct 2026).' },
  { route: 'POST /:schoolId/students/:studentId/promote', reason: 'No screen called it; Assign Class and Promotions replace it (spec 2026-10-08).' },
  { route: 'POST /:schoolId/payments/paystack/initiate (for a student)', reason: 'Parents pay; a student does not start a payment (spec 2026-10-08).' },
];
```

  A whole route that is gone is checked by the walker; a role taken off a route is checked by the matrix test that
  owns it (named in `reason`).
- [ ] **Step 3:** Controls: a fake router with an unguarded route, one with two guards, one with `requireRole` left
  in, and a removed route mounted again each make the test fail. Commit.

### Tasks 3–9: Move the routes, file by file

Each task: replace the file's `requireSchoolAccess` and every `requireRole` with one `requireCapability(...)` per route
as the appendix says; delete the file's `requireSchoolAccess`; take the file off `NOT_YET_MOVED`; add the file's rows to
`capabilityMatrix.db.test.ts`. The matrix calls one route per capability as every role (principal, registrar, bursar,
teacher, parent, student, platform admin, and a principal of another school) and asserts holders are not refused (any
status but 403) and everyone else gets 403. Every behaviour change in the appendix gets a test that fails on the old
code, written and run first.

| Task | Files | Changes from today (each tested first) |
|---|---|---|
| 3 | schools.ts, sessions.ts, users.ts | Payout save is `school.payout.manage`; Fee Settings stops naming the bursar; email change is `staff.email` |
| 4 | roster.ts, assessmentConfig.ts, timetable.ts | Registrar gains classes and subjects, never the form teacher; a teacher reads only their own assignments; assessment-structure reads are principal only |
| 5 | students.ts | Teacher loses the student list and profile; bursar gains them read-only; `POST /promote` removed |
| 6 | scores.ts, results.ts, principalRemarks.ts, dashboard.ts, teacherDashboard.ts, analytics.ts, classComments.ts | Pending scores: principal, and a teacher their own |
| 7 | attendance.ts, behaviour.ts, notices.ts | Decision 7: a teacher's reads of a student's attendance and behaviour keep to classes they teach or form-teach. Ruling (8 Oct 2026): the class summary and the open alerts become the principal's (`school.overview`) instead of being filtered per teacher, as decision 4 did for reads only the principal's screens use; the alerts named students of every class |
| 8 | fees.ts, platformBilling.ts | Principal gains every bursar fee job (fee lines, invoices, payments, refunds, import, reminders); a student no longer reads invoices or starts a payment |
| 9 | parent.ts, student.ts, assignments.ts, messages.ts, announcements.ts, notifications.ts | `GET /assignments` drops the principal; parent routes stop admitting a platform admin |

### Task 10: The web reads the table

**Files:** `apps/web/lib/navigation.ts`, `lib/commandPalette.ts`, `app/(dashboard)/layout.tsx`,
`app/(dashboard)/registrar/layout.tsx`, `app/(dashboard)/settings/*`, `settings/roster/page.tsx`,
`registrar/students/*`, tests in `lib/__tests__/`.

- [ ] Each `NavItem` names its capability. A role's sidebar is the items whose capability the role holds;
  `settingsAccessForRole` and `settingsGroupsForRole` become that same filter.
- [ ] The dashboard layout refuses a page whose nav item (longest-prefix match on the path) the role does not hold,
  in one place, replacing `registrar/layout.tsx`'s role list.
- [ ] The principal gets a Fees group (Fee Structures, Invoices, Outstanding Balances, Collection Summary); the
  bursar gets Students (read-only: no Register, Import, Assign Class or edit); the registrar gets Settings → Roster
  with Classes and Subjects only, loading without the staff list.
- [ ] Tests: per role, the sidebar EQUALS the items the table gives it; every item names a capability in the table;
  labels still never collide.

### Task 11: Pages against routes

- [ ] `apps/api/src/__tests__/pageRouteAgreement.test.ts` reads every page under `apps/web/app/(dashboard)`, finds each
  `/api/schools/${schoolId}/…` call, resolves it to a mounted route and its capabilities, and fails when a role shown
  the page holds none of them. A call a page makes only for some roles (the registrar list's principal-only summary)
  is listed with its reason. Controls: a page calling a principal-only route from the bursar's area fails. This is the
  test that would have caught the four screen faults of 8 Oct (the principal's Students link, the bursar's Settings
  rail, Fee Settings, Platform Billing).

### Task 12: Docs, and the old guard gone

- [ ] `NOT_YET_MOVED` is empty, and the walker asserts it. `requireRole` is used on no school route.
- [ ] CLAUDE.md doctrine 1 rewritten for the one guard and the table; the refund note updated (principal and bursar);
  the sidebar and palette notes. `docs/roles-guide.md` regenerated from the table. CHANGELOG. SECURITY.md for any
  route that admitted a role it should not have. `docs/AUDIT-2026-09.md`: C-4's "single app-level tenant guard"
  closed.
- [ ] Full gate. Then a walk through each role's screens on a local build, as a checklist for Moses after deploy.
