import { Request, Response, NextFunction } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes a READ-ONLY school may still make: the routes that let it pay Chronix and so
 * restore its own access. Blocking those would turn every lapse into a support call.
 *
 * ONE ENTRY TODAY (migration 052 / routes/platformBilling.ts's checkout route): a
 * principal, bursar or super_admin may start a Paystack checkout for the school's own
 * subscription while read-only, so paying is how a lapsed school gets itself back to full
 * access without a support call. Recovery otherwise is still a payment recorded by a
 * super_admin (POST /api/super-admin/subscriptions/:id/record-payment), which is outside
 * this guard, or extending the trial, or a PATCH. carveOut.test.ts walks every write route
 * mounted under /api/schools and fails if one matching PLATFORM_PAYMENT_PATH is not
 * admitted here (doctrine 7: check each operation, one at a time) — the checkout route's
 * own test asserts it still answers while the school is read_only.
 * /api/auth/* — login, change password — is not under /api/schools and is never blocked.
 * The webhook and browser callback that settle a checkout (routes/platformBillingPublic.ts)
 * never reach this guard at all: they are mounted before the auth chain, same as
 * routes/feesPublic.ts, because Paystack cannot supply a bearer token for either.
 *
 * `path` is matched against the path relative to the /api/schools mount, e.g.
 * "/<schoolId>/platform-billing/checkout".
 */
export const READ_ONLY_WRITE_ALLOWLIST: Array<{ method: string; path: RegExp; why: string }> = [
  {
    method: 'POST',
    path: /^\/[0-9a-f-]{36}\/platform-billing\/checkout$/i,
    why: "Lets a read-only (lapsed-trial) school pay Chronix online to restore its own access — blocking it would turn every lapse into a support call.",
  },
];

/**
 * THE CONTRACT for any route that lets a school pay Chronix: its path must match this, so
 * it can be recognised as one. carveOut.test.ts walks every write route mounted under
 * /api/schools and fails if a route matching this is NOT admitted by the allowlist — so the
 * payment system cannot ship a checkout that read-only then blocks, which would leave a
 * lapsed school unable to pay to restore its own access. The test can only see what the
 * path says; a payment route named some other way escapes it, which is why the convention
 * is written here and in CLAUDE.md.
 */
export const PLATFORM_PAYMENT_PATH = /\/(platform-billing|subscription|renew|checkout)(\/|$)/i;

/** Whether a write to this path (relative to the /api/schools mount) is carved out. */
export function isAllowedWhileReadOnly(method: string, path: string): boolean {
  return READ_ONLY_WRITE_ALLOWLIST.some(e => e.method === method && e.path.test(path));
}

/**
 * The trial gate's read-only state (migration 046): every GET works, every write under
 * /api/schools/:schoolId is refused with 423 SCHOOL_READ_ONLY. Keyed on the SUBSCRIPTION
 * status carried on res.locals.school by requireActiveSchool — never on schools.is_active,
 * which is a separate, deliberate administrator decision. Super admins bypass, as they do in
 * requireActiveSchool. Mounted directly after requireActiveSchool.
 */
export function requireWritableSubscription(req: Request, res: Response, next: NextFunction): void {
  if (READ_METHODS.has(req.method)) { next(); return; }

  const schoolId = req.path.split('/')[1];
  if (!schoolId || !UUID_RE.test(schoolId)) { next(); return; }
  if (req.user?.role === 'super_admin') { next(); return; }

  const school = res.locals.school as { subscription_status?: string | null } | undefined;
  if (school?.subscription_status !== 'read_only') { next(); return; }

  if (isAllowedWhileReadOnly(req.method, req.path)) { next(); return; }

  res.status(423).json({
    success: false,
    error: {
      code: 'SCHOOL_READ_ONLY',
      message: "This school's trial has ended, so changes are paused. All records are still here and can be viewed and exported. Renewing the subscription restores full access.",
    },
  });
}
