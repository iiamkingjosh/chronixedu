/**
 * One table of who can do what (spec docs/superpowers/specs/2026-10-08-roles-permissions-design.md).
 *
 * config/capabilities.json is the only statement of which roles do which job. The API reads it through
 * requireCapability, the web reads an exact copy. These tests pin its shape and the rules Moses stated, so
 * changing either is a decision someone makes, never a drift; and they pin the guard's answers, each refusal
 * beside an admission for the same route (doctrine 16).
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import table from '../config/capabilities.json';
import { requireCapability, capabilitiesOf } from '../middleware/requireCapability';

const caps = table.capabilities as Record<string, { roles: string[]; platform_admin: boolean }>;
const holds = (role: string) => Object.keys(caps).filter((c) => caps[c].roles.includes(role));

describe('the table', () => {
  it('has an exact copy in the web app (copy apps/api/src/config/capabilities.json to apps/web/lib/)', () => {
    const web = fs.readFileSync(path.join(__dirname, '../../../web/lib/capabilities.json'), 'utf8');
    expect(JSON.parse(web)).toEqual(table);
  });

  it('names only real roles, and every row states whether a platform admin holds it (doctrine 8)', () => {
    expect(table.roles.sort()).toEqual(['bursar', 'parent', 'principal', 'registrar', 'student', 'teacher']);
    for (const [cap, row] of Object.entries(caps)) {
      expect({ cap, unknown: row.roles.filter((r) => !table.roles.includes(r)) }).toEqual({ cap, unknown: [] });
      expect({ cap, stated: typeof row.platform_admin }).toEqual({ cap, stated: 'boolean' });
    }
  });

  it('gives the principal everything the bursar has, and everything the registrar has (Moses, 8 Oct 2026)', () => {
    // A school with no bursar or no registrar is never stuck, and a new fee or student job cannot be
    // given to the bursar or registrar alone: the rule is on the table, not on a list of routes.
    expect(holds('bursar').length).toBeGreaterThan(0);
    expect(holds('registrar').length).toBeGreaterThan(0);
    expect(holds('bursar').filter((c) => !caps[c].roles.includes('principal'))).toEqual([]);
    expect(holds('registrar').filter((c) => !caps[c].roles.includes('principal'))).toEqual([]);
  });

  it("leaves a staff member's email to the platform admin: it is the account's only key", () => {
    // A password reset goes to this address, so whoever can change it can take the account. Held hardest
    // of the 8 Oct 2026 answers: no school role, the principal included.
    expect(caps['staff.email']).toEqual({ roles: [], platform_admin: true });
  });

  it('lets the bursar view Payout Setup and only the principal save it ("Only view to avoid changes")', () => {
    expect(caps['school.payout.view'].roles).toEqual(['principal', 'bursar']);
    expect(caps['school.payout.manage'].roles).toEqual(['principal']);
  });

  it('leaves recording a refund to the school: the bursar or the principal, never the platform admin as itself', () => {
    // Refunds were the bursar's alone (6 Oct 2026); the principal since 8 Oct. Folding them into fees.manage
    // would have given them to the platform admin as well, which nobody decided (review of Batch 9).
    expect(caps['fees.refund']).toEqual({ roles: ['principal', 'bursar'], platform_admin: false });
  });

  it("keeps the parent's, student's and teacher's own portals from the platform admin", () => {
    // A platform admin sees a school as one of its users, through a support session, whose token carries
    // that user's role.
    for (const portal of ['parent.portal', 'student.portal', 'teacher.workspace']) {
      expect({ portal, platform_admin: caps[portal].platform_admin }).toEqual({ portal, platform_admin: false });
    }
  });
});

describe('requireCapability', () => {
  const SCHOOL = 'a0000000-0000-4000-8000-000000000001';
  const OTHER = 'b0000000-0000-4000-8000-000000000002';

  function appWith(guard: express.RequestHandler, user?: Record<string, unknown>) {
    const app = express();
    app.use((req, _res, next) => { if (user) req.user = user as never; next(); });
    app.get('/api/schools/:schoolId/thing', guard, (_req, res) => { res.json({ success: true }); });
    return app;
  }
  const call = (guard: express.RequestHandler, user?: Record<string, unknown>, school = SCHOOL) =>
    request(appWith(guard, user)).get(`/api/schools/${school}/thing`);

  it('admits a holder of the capability at their own school, and refuses the same holder at another', async () => {
    const guard = requireCapability('fees.manage');
    expect((await call(guard, { user_id: 'u', role: 'bursar', school_id: SCHOOL })).status).toBe(200);
    const elsewhere = await call(guard, { user_id: 'u', role: 'bursar', school_id: SCHOOL }, OTHER);
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a role that does not hold it, at its own school', async () => {
    const guard = requireCapability('fees.manage');
    expect((await call(guard, { user_id: 'u', role: 'principal', school_id: SCHOOL })).status).toBe(200);
    const teacher = await call(guard, { user_id: 'u', role: 'teacher', school_id: SCHOOL });
    expect(teacher.status).toBe(403);
    expect(teacher.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a token with no role, and answers 401 with no user at all', async () => {
    const guard = requireCapability('school.member');
    expect((await call(guard, { user_id: 'u', role: 'student', school_id: SCHOOL })).status).toBe(200);
    expect((await call(guard, { user_id: 'u', school_id: SCHOOL })).status).toBe(403);
    const none = await call(guard);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHORIZED');
  });

  it('admits a platform admin at any school where the row says so, and only there', async () => {
    const admin = { user_id: 'a', role: 'super_admin' };
    expect((await call(requireCapability('school.setup'), admin, OTHER)).status).toBe(200);
    expect((await call(requireCapability('parent.portal'), admin)).status).toBe(403);
    expect((await call(requireCapability('staff.email'), admin)).status).toBe(200);
    expect((await call(requireCapability('staff.email'), { user_id: 'u', role: 'principal', school_id: SCHOOL })).status).toBe(403);
  });

  it('admits on any one of several capabilities, and refuses a role holding none of them', async () => {
    const guard = requireCapability('fees.manage', 'parent.portal');
    expect((await call(guard, { user_id: 'u', role: 'parent', school_id: SCHOOL })).status).toBe(200);
    expect((await call(guard, { user_id: 'u', role: 'bursar', school_id: SCHOOL })).status).toBe(200);
    expect((await call(guard, { user_id: 'u', role: 'student', school_id: SCHOOL })).status).toBe(403);
  });

  it('says which capabilities a guard names, for the route walker, and nothing for another handler', () => {
    expect(capabilitiesOf(requireCapability('fees.manage', 'parent.portal'))).toEqual(['fees.manage', 'parent.portal']);
    expect(capabilitiesOf((_req: unknown, _res: unknown, next: () => void) => next())).toBeUndefined();
  });

  it('refuses to be built naming nothing, or a capability the table does not have', () => {
    expect(() => requireCapability()).toThrow();
    expect(() => requireCapability('no.such.job' as never)).toThrow(/no\.such\.job/);
  });
});
