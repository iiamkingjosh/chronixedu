import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { logger } from '../config/logger';

/**
 * Machine-to-machine auth for `/api/partner/*`, deliberately separate from
 * `verifyToken`/`requireRole`.
 *
 * Those middlewares answer "which human is this, and what may they do in their school".
 * This answers "is this the ERP". Sharing one path would mean a partner request carrying
 * a `req.user` that no route should trust, and a human session reaching a route that
 * assumes a machine caller. Different question, different middleware.
 *
 * Unset key means the integration is OFF: 503, never 200 and never a fall-open. A
 * partner route that silently starts serving because a variable went missing is the
 * failure this is written to avoid.
 */
export function requireErpApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ERP_INTEGRATION_API_KEY;
  if (!expected) {
    res.status(503).json({
      success: false,
      error: { code: 'NOT_CONFIGURED', message: 'ERP integration is not configured on this server' },
    });
    return;
  }

  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string') {
    // Logged without any part of the key — doctrine 13's reasoning applies to every
    // shared secret, not just the service role key. The path is enough to diagnose.
    logger.warn('erp_api_key_missing', { path: req.path });
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    return;
  }

  // Compare BYTES, not characters. `timingSafeEqual` throws on unequal buffer lengths,
  // and String.length counts UTF-16 code units — so a key containing any multi-byte
  // character could pass a `.length` check and then throw inside the comparison, turning
  // a 401 into an unhandled 500. Building both buffers first and comparing byteLength
  // removes that path entirely.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length is compared non-constant-time on purpose: it leaks only the key's length,
  // which is not secret, and it is the precondition timingSafeEqual requires.
  const ok = a.length === b.length && timingSafeEqual(a, b);

  if (!ok) {
    logger.warn('erp_api_key_invalid', { path: req.path });
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    return;
  }

  next();
}
