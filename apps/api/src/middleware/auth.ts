import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as Sentry from '@sentry/node';
import { redis, bestEffort } from './rateLimit';
import pool from '../db/client';
import { logger } from '../config/logger';
import { USER_ACTIVE_CACHE_SECONDS, MUST_CHANGE_PASSWORD_CACHE_SECONDS } from '../config/cacheTimes';

export interface AuthUser {
  user_id: string;
  school_id?: string;
  role?: string;
  email?: string;
  title?: string;
  [key: string]: unknown;
}

export interface SupportSessionContext {
  sessionId: string;
  realAdminId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    rawBody?: Buffer;
    supportSession?: SupportSessionContext;
  }
}

/**
 * The only routes a platform admin who must enrol in two-factor, and has not yet, can reach
 * (migration 058). Everything else behind verifyToken answers 403 TWO_FACTOR_SETUP_REQUIRED.
 * Full paths, matched exactly: a trailing slash, a different case or a HEAD request is refused,
 * which fails closed. twoFactorSetupRoutes.test.ts walks every route behind verifyToken and fails if
 * this admits any other route, or names a route that does not exist.
 */
export const TWO_FACTOR_SETUP_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/super-admin/two-factor/status' },
  { method: 'POST', path: '/api/super-admin/two-factor/enrolment' },
  { method: 'POST', path: '/api/super-admin/two-factor/enrolment/confirm' },
];

export function isTwoFactorSetupRoute(method: string, fullPath: string): boolean {
  return TWO_FACTOR_SETUP_ROUTES.some(r => r.method === method && r.path === fullPath);
}

/** The second factors a token can record (routes/auth.ts /login/verify, routes/twoFactor.ts). */
const SECOND_FACTORS: readonly unknown[] = ['totp', 'recovery_code'];

function tagSentry(user: AuthUser) {
  Sentry.setTag('school_id', user.school_id ?? 'none');
  Sentry.setTag('user_role', user.role ?? 'anonymous');
  // Id only. The DPA names Sentry for "technical/diagnostic data only"; the email that was
  // sent here was personal data. The id still traces an error to a user through our own DB.
  Sentry.setUser({ id: user.user_id });
}

export async function verifyToken(req: Request, res: Response, next: NextFunction) {
  // detectSupportSession (or an upstream verifyToken call) already authenticated
  // this request — skip re-verification and just tag Sentry with what we have.
  if (req.user) {
    tagSentry(req.user);
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } });
  }
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid Authorization format' } });
  }
  const token = parts[1];

  // Step 1: verify the JWT signature. Only auth errors live in this catch block.
  let payload: AuthUser;
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is not set');
    payload = jwt.verify(token, secret) as AuthUser;
  } catch {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
  }

  // Step 1b: support session tokens must always include the matching header.
  // This prevents a scoped token from being replayed as a regular JWT.
  if (payload.is_support_session) {
    const headerSessionId = req.headers['x-support-session-id'];
    const headerStr = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId;
    if (!headerStr || headerStr !== (payload.support_session_id as string)) {
      return res.status(403).json({
        success: false,
        error: { code: 'MISSING_SESSION_HEADER', message: 'Support session header required' },
      });
    }
  }

  // Step 2: check if the user is still active and whether the token has been revoked.
  // Separate try/catch so a DB error returns 503 rather than a misleading 401 — the
  // request is rejected, not passed through. Redis, by contrast, is best-effort here
  // (SECURITY.md Round 19, decided: fail open): user_active is a cache in front of the
  // query below, so a Redis failure costs a query, and the blacklist only ever holds
  // support-session tokens, which detectSupportSession also gates on the DB's ended_at —
  // the same reasoning under which it already fails open on this key. Without this, a
  // Redis outage answered every authenticated request with 503.
  try {
    // Check the token blacklist (revoked support session tokens).
    if (redis) {
      const r = redis;
      const isBlacklisted = await bestEffort('token_blacklist_unavailable', () => r.get(`blacklisted_token:${token}`));
      if (isBlacklisted) {
        return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: 'Token has been revoked' } });
      }
    }

    // A platform admin's own token (not a support-session token, which carries the impersonated
    // user) is checked against the live row on every request, never the cache: enrolling in two-factor
    // ends every other session the admin had (users.sessions_valid_after, migration 056), and a cached
    // "active" could let one run on for five minutes. Only platform admins can enrol, so only their
    // tokens are checked; widen this if anyone else ever can. Platform-admin requests are few.
    const adminToken = payload.role === 'super_admin' && !payload.is_support_session;
    const cacheKey = `user_active:${payload.user_id}`;
    let isActive = true;
    let sessionsValidAfter: Date | null = null;
    // Admin tokens only: whether two-factor is on, and whether this admin must switch it on.
    let twoFactorOn = false;
    let twoFactorExempt = false;
    let cached: string | null | undefined = null;
    if (redis && !adminToken) {
      const r = redis;
      cached = await bestEffort('user_active_cache_unavailable', () => r.get(cacheKey));
    }
    if (cached !== null && cached !== undefined) {
      isActive = cached === '1';
    } else {
      const result = await pool.query(
        adminToken
          ? `SELECT is_active, sessions_valid_after, two_factor_required,
                    EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = users.id AND t.activated_at IS NOT NULL) AS two_factor_on
               FROM users WHERE id = $1`
          : 'SELECT is_active, sessions_valid_after FROM users WHERE id = $1',
        [payload.user_id]);
      // A token for an account whose row is gone is refused, for every role (4 Oct 2026,
      // docs/AUDIT-2026-09.md fix (b)). It used to read as active: is_active !== false is true of a
      // missing row. Nothing is cached for it, so the refusal repeats on every request. A "1" cached
      // while the row still existed can answer for up to USER_ACTIVE_CACHE_SECONDS after it goes;
      // deleting a school suspends it and waits that out first (scripts/delete-school-data.js).
      if (!result.rows[0]) {
        return res.status(401).json({ success: false, error: { code: 'ACCOUNT_NOT_FOUND', message: 'This account no longer exists.' } });
      }
      isActive = result.rows[0].is_active !== false;
      sessionsValidAfter = result.rows[0].sessions_valid_after ?? null;
      twoFactorOn = result.rows[0].two_factor_on === true;
      // Exempt only when the row says so (false: an admin who existed before migration 058, whose
      // choice it stays). The CHECK makes NULL impossible for a super_admin.
      twoFactorExempt = result.rows[0].two_factor_required === false;
      if (redis) {
        const r = redis;
        const value = isActive ? '1' : '0';
        await bestEffort('user_active_cache_unavailable', () => r.set(cacheKey, value, 'EX', USER_ACTIVE_CACHE_SECONDS));
      }
    }

    if (!isActive) {
      return res.status(403).json({ success: false, error: { code: 'ACCOUNT_SUSPENDED', message: 'Your account has been suspended' } });
    }
    // Whole seconds, because a JWT's iat is: a token issued in the same second as the cut-off is
    // kept, which is what lets the enrolling session's fresh token survive its own cut-off.
    const issuedAt = (payload as { iat?: number }).iat;
    if (adminToken && sessionsValidAfter && typeof issuedAt === 'number'
        && issuedAt < Math.floor(new Date(sessionsValidAfter).getTime() / 1000)) {
      return res.status(401).json({ success: false, error: { code: 'SESSION_ENDED', message: 'This session has ended. Please sign in again.' } });
    }
    // Two-factor (commit 4). An admin who has it on needs a token that records the second factor:
    // a token from the password alone (issued before it was switched on, or by anything that skipped
    // the code step) is refused everywhere. An admin who must switch it on, and has not, reaches only
    // the setup routes. The messages here are not what a person reads: the web app sends a 401 to
    // the sign-in page and a 403 to the setup page, each of which says why.
    if (adminToken && twoFactorOn && !SECOND_FACTORS.includes(payload.second_factor)) {
      return res.status(401).json({ success: false, error: { code: 'SECOND_FACTOR_REQUIRED', message: 'Sign in again with your authenticator code.' } });
    }
    if (adminToken && !twoFactorOn && !twoFactorExempt && !isTwoFactorSetupRoute(req.method, req.baseUrl + req.path)) {
      return res.status(403).json({ success: false, error: { code: 'TWO_FACTOR_SETUP_REQUIRED', message: 'Set up two-factor sign-in before continuing.' } });
    }
  } catch (err) {
    logger.error('auth_suspension_check_failed', { error: err instanceof Error ? err.message : String(err) });
    return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service temporarily unavailable. Please try again.' } });
  }

  req.user = payload;
  tagSentry(payload);
  return next();
}

/** Blocks every route this is mounted on whenever the account still has a
 *  pending forced password change — the only way past it is to actually
 *  change the password via POST /api/auth/change-password (a different
 *  router, never touched by this middleware). This closes the real risk in
 *  a shared/predictable temp password: whoever authenticates with it first
 *  — the legitimate recipient or an attacker who reached it first — gets a
 *  session that can do nothing except set a new password, not read or
 *  write any school data.
 *
 *  Checks live DB state (Redis-cached, same pattern as the is_active check
 *  above) rather than trusting the JWT's baked-in claim, so a user who
 *  changes their password mid-token-lifetime is unblocked on their very
 *  next request — see the cache invalidation in routes/auth.ts's
 *  change-password and confirm-reset handlers. */
export async function requirePasswordChanged(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
  }

  try {
    const userId = req.user.user_id;
    const cacheKey = `must_change_password:${userId}`;
    let mustChange: boolean;
    // Cache in front of the query; Redis best-effort (SECURITY.md Round 19).
    let cached: string | null | undefined = null;
    if (redis) {
      const r = redis;
      cached = await bestEffort('must_change_password_cache_unavailable', () => r.get(cacheKey));
    }
    if (cached !== null && cached !== undefined) {
      mustChange = cached === '1';
    } else {
      const result = await pool.query('SELECT must_change_password FROM users WHERE id = $1', [userId]);
      // A missing row is refused here too (fix (b)); it used to read as "no change needed".
      if (!result.rows[0]) {
        return res.status(401).json({ success: false, error: { code: 'ACCOUNT_NOT_FOUND', message: 'This account no longer exists.' } });
      }
      mustChange = result.rows[0].must_change_password === true;
      if (redis) {
        const r = redis;
        const value = mustChange ? '1' : '0';
        await bestEffort('must_change_password_cache_unavailable', () => r.set(cacheKey, value, 'EX', MUST_CHANGE_PASSWORD_CACHE_SECONDS));
      }
    }

    if (mustChange) {
      return res.status(403).json({
        success: false,
        error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'You must change your temporary password before continuing.' },
      });
    }
  } catch (err) {
    logger.error('must_change_password_check_failed', { error: err instanceof Error ? err.message : String(err) });
    return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service temporarily unavailable. Please try again.' } });
  }

  return next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Missing role' } });
    if (!roles.includes(role)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    return next();
  };
}

export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void | Response {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Super admin access required'
      },
    });
  }
  return next();
}
