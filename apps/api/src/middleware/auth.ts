import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as Sentry from '@sentry/node';
import { redis } from './rateLimit';
import pool from '../db/client';
import { logger } from '../config/logger';

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

function tagSentry(user: AuthUser) {
  Sentry.setTag('school_id', user.school_id ?? 'none');
  Sentry.setTag('user_role', user.role ?? 'anonymous');
  Sentry.setUser({ id: user.user_id, email: user.email });
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
  // Separate try/catch so DB or Redis errors return 503 rather than a misleading 401 —
  // the request is rejected, not passed through.
  try {
    // Check the token blacklist (revoked support session tokens).
    if (redis) {
      const isBlacklisted = await redis.get(`blacklisted_token:${token}`);
      if (isBlacklisted) {
        return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: 'Token has been revoked' } });
      }
    }

    const cacheKey = `user_active:${payload.user_id}`;
    let isActive = true;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        isActive = cached === '1';
      } else {
        const result = await pool.query('SELECT is_active FROM users WHERE id = $1', [payload.user_id]);
        isActive = result.rows[0]?.is_active !== false;
        await redis.set(cacheKey, isActive ? '1' : '0', 'EX', 300);
      }
    } else {
      const result = await pool.query('SELECT is_active FROM users WHERE id = $1', [payload.user_id]);
      isActive = result.rows[0]?.is_active !== false;
    }

    if (!isActive) {
      return res.status(403).json({ success: false, error: { code: 'ACCOUNT_SUSPENDED', message: 'Your account has been suspended' } });
    }
  } catch (err) {
    logger.error('auth_suspension_check_failed', { error: err instanceof Error ? err.message : String(err) });
    return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service temporarily unavailable. Please try again.' } });
  }

  req.user = payload;
  tagSentry(payload);
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
