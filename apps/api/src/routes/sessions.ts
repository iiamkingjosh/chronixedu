import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { redis } from '../middleware/rateLimit';
import { logAudit } from '../db/queries/auditLog';
import {
  insertSession,
  listSessionsWithTerms,
  findSessionById,
  insertTerm,
  activateSession,
  getCurrentContext,
} from '../db/queries/sessions';

const router = Router();


// ── Validation schemas ─────────────────────────────────────────────────────────

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const sessionSchema = z.object({
  name:       z.string().min(1).max(255),
  start_date: z.string().regex(datePattern, 'Must be YYYY-MM-DD'),
  end_date:   z.string().regex(datePattern, 'Must be YYYY-MM-DD'),
});

const termSchema = z.object({
  name:       z.string().min(1).max(255),
  start_date: z.string().regex(datePattern, 'Must be YYYY-MM-DD'),
  end_date:   z.string().regex(datePattern, 'Must be YYYY-MM-DD'),
});

// ── Middleware: super_admin or any user belonging to the school ─────────────────

function requireSchoolAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.role === 'super_admin') { next(); return; }
  if (user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

// ── POST /:schoolId/sessions ───────────────────────────────────────────────────

router.post(
  '/:schoolId/sessions',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = sessionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { name, start_date, end_date } = parsed.data;
      const session = await insertSession(req.params.schoolId, name, start_date, end_date);
      return res.status(201).json({ success: true, data: session });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/sessions ────────────────────────────────────────────────────

router.get(
  '/:schoolId/sessions',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessions = await listSessionsWithTerms(req.params.schoolId);
      return res.json({ success: true, data: sessions });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/sessions/:sessionId/terms ──────────────────────────────────

router.post(
  '/:schoolId/sessions/:sessionId/terms',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      // Verify session belongs to this school before inserting
      const session = await findSessionById(req.params.sessionId, req.params.schoolId);
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
      }

      const { name, start_date, end_date } = parsed.data;
      const term = await insertTerm(req.params.sessionId, req.params.schoolId, name, start_date, end_date);
      return res.status(201).json({ success: true, data: term });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/sessions/:sessionId/activate ─────────────────────────────

router.patch(
  '/:schoolId/sessions/:sessionId/activate',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.body.confirm !== true) {
        return res.status(400).json({
          success: false,
          error: { code: 'CONFIRMATION_REQUIRED', message: 'Body must include { "confirm": true } to activate a session' },
        });
      }

      const session = await findSessionById(req.params.sessionId, req.params.schoolId);
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
      }

      await activateSession(req.params.schoolId, req.params.sessionId);

      // Bust the cache so the next current-context request is fresh
      if (redis) await redis.del(`ctx:${req.params.schoolId}`);

      await logAudit({
        schoolId:   req.params.schoolId,
        userId:     req.user!.user_id,
        actionType: 'SESSION_ACTIVATED',
        entity:     'academic_sessions',
        entityId:   req.params.sessionId,
        newValue:   { session_id: req.params.sessionId, name: session.name },
      });

      return res.json({ success: true, data: { message: 'Session activated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/current-context ─────────────────────────────────────────────

router.get(
  '/:schoolId/current-context',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = `ctx:${req.params.schoolId}`;
      if (redis) {
        const hit = await redis.get(cacheKey);
        if (hit !== null) {
          return res.json({ success: true, data: JSON.parse(hit) });
        }
      }

      const context = await getCurrentContext(req.params.schoolId);
      if (redis) await redis.set(cacheKey, JSON.stringify(context), 'EX', 60);
      return res.json({ success: true, data: context });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
