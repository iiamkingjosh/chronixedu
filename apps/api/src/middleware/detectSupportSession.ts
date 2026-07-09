// Verified P45: all 5 properties confirmed
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/client';
import { redis } from './rateLimit';
import type { AuthUser, SupportSessionContext } from './auth';

export interface SupportSessionClaims {
  support_session_id: string;
  is_support_session: boolean;
  real_admin_id: string;
  impersonated_user_id: string;
  impersonated_school_id: string;
  impersonated_role: string;
  impersonated_email: string;
  impersonated_title: string | null;
}

export async function detectSupportSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const header = req.headers['x-support-session-id'];
  if (!header) {
    return next();
  }
  const supportSessionId = Array.isArray(header) ? header[0] : header;

  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } });
  }
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid Authorization format' } });
  }
  const token = parts[1];

  let claims: SupportSessionClaims;
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is not set');
    claims = jwt.verify(token, secret) as unknown as SupportSessionClaims;
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_SUPPORT_TOKEN', message: 'Invalid or expired support session token' } });
  }

  // Check if this token has been explicitly revoked (e.g. the session was ended early).
  if (redis) {
    try {
      const isBlacklisted = await redis.get(`blacklisted_token:${token}`);
      if (isBlacklisted) {
        return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: 'Token has been revoked' } });
      }
    } catch {
      // Redis unavailable — fail open; the DB ended_at check below still gates access.
    }
  }

  if (claims.support_session_id !== supportSessionId) {
    return res.status(401).json({ success: false, error: { code: 'SESSION_MISMATCH', message: 'Support session header does not match token' } });
  }

  try {
    const result = await pool.query<{ id: string; ended_at: string | null; platform_admin_id: string }>(
      `SELECT id, ended_at, platform_admin_id FROM support_sessions WHERE id = $1`,
      [claims.support_session_id]
    );
    const session = result.rows[0];
    if (!session || session.ended_at !== null) {
      return res.status(401).json({ success: false, error: { code: 'SESSION_ENDED', message: 'Support session has ended or does not exist' } });
    }

    req.user = {
      user_id: claims.impersonated_user_id,
      school_id: claims.impersonated_school_id,
      role: claims.impersonated_role,
      email: claims.impersonated_email,
      title: claims.impersonated_title ?? undefined,
    } as AuthUser;

    const ctx: SupportSessionContext = {
      sessionId: session.id,
      realAdminId: session.platform_admin_id,
    };
    req.supportSession = ctx;

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to verify support session' } });
  }
}
