import { Request, Response, NextFunction, RequestHandler } from 'express';
import table from '../config/capabilities.json';

export type Capability = keyof typeof table.capabilities;

interface Row { roles: string[]; platform_admin: boolean }
const rows = table.capabilities as Record<Capability, Row>;

// Which capabilities each guard names, read by the route walker (capabilityRoutes.test.ts).
const named = new WeakMap<RequestHandler, readonly Capability[]>();

/**
 * The one guard on a school route (spec docs/superpowers/specs/2026-10-08-roles-permissions-design.md).
 *
 * The caller's own school (doctrine 1: the tenant comes from the verified token), then a role that holds any of
 * the named capabilities in config/capabilities.json. A platform admin passes at any school, but only where the
 * row says platform_admin. A support-session token carries the school user's role, so it is judged as that
 * role, never as a platform admin. Which records the caller may touch (a teacher's classes, a parent's
 * children) stays in the handler: the table decides whether a role does a job, the route decides which rows.
 */
export function requireCapability(...caps: Capability[]): RequestHandler {
  if (caps.length === 0) throw new Error('requireCapability needs at least one capability');
  const unknown = caps.filter((c) => !(c in rows));
  if (unknown.length > 0) throw new Error(`requireCapability: not in config/capabilities.json: ${unknown.join(', ')}`);

  const guard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      return;
    }
    const platform = user.role === 'super_admin';
    if (!platform && user.school_id !== req.params.schoolId) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      return;
    }
    const role = user.role;
    const admitted = caps.some((c) => (platform ? rows[c].platform_admin : role !== undefined && rows[c].roles.includes(role)));
    if (!admitted) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      return;
    }
    next();
  };
  named.set(guard, Object.freeze([...caps]));
  return guard;
}

/** The capabilities a guard names, for the route walker; undefined for any other handler. */
export function capabilitiesOf(handler: unknown): readonly Capability[] | undefined {
  return typeof handler === 'function' ? named.get(handler as RequestHandler) : undefined;
}

/** The school roles that hold a capability (not counting the platform admin). */
export function rolesFor(cap: Capability): readonly string[] {
  return rows[cap].roles;
}
