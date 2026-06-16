// Verified P45: all 5 properties confirmed
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/client';
import type { AuthUser } from './auth';

export interface SupportSessionClaims {
  support_session_id: string;
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
    claims = jwt.verify(token, process.env.JWT_SECRET || '') as unknown as SupportSessionClaims;
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_SUPPORT_TOKEN', message: 'Invalid or expired support session token' } });
  }

  if (claims.support_session_id !== supportSessionId) {
    return res.status(401).json({ success: false, error: { code: 'SESSION_MISMATCH', message: 'Support session header does not match token' } });
  }

  try {
    const result = await pool.query<{ id: string; ended_at: string | null }>(
      `SELECT id, ended_at FROM support_sessions WHERE id = $1`,
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

    (req as Request & { support_session_id?: string }).support_session_id = claims.support_session_id;

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to verify support session' } });
  }
}
