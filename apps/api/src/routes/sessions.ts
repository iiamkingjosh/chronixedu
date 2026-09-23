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
  findTermById,
  activateTerm,
  getCurrentContext,
  listTermsBySession,
  updateTerm,
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

const termPatchSchema = z
  .object({
    name:       z.string().min(1).max(255).optional(),
    start_date: z.string().regex(datePattern, 'Must be YYYY-MM-DD').optional(),
    end_date:   z.string().regex(datePattern, 'Must be YYYY-MM-DD').optional(),
  })
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

/**
 * Rejects a term whose dates are inverted or overlap a sibling term in the same
 * session. Overlap is not cosmetic: findTermForDate() resolves a date to a term with
 * `LIMIT 1` and no ordering, so overlapping terms make attendance land in whichever
 * term the planner happens to return. `excludeTermId` skips the row being edited.
 */
async function findTermDateConflict(
  sessionId: string,
  schoolId: string,
  startDate: string,
  endDate: string,
  excludeTermId?: string
): Promise<string | null> {
  if (new Date(endDate) <= new Date(startDate)) {
    return 'end_date must be after start_date';
  }
  const siblings = await listTermsBySession(sessionId, schoolId);
  const clash = siblings.find(t => {
    if (excludeTermId && t.id === excludeTermId) return false;
    return new Date(startDate) <= new Date(t.end_date) && new Date(endDate) >= new Date(t.start_date);
  });
  return clash ? `These dates overlap "${clash.name}" (${clash.start_date} – ${clash.end_date})` : null;
}

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

      const conflict = await findTermDateConflict(req.params.sessionId, req.params.schoolId, start_date, end_date);
      if (conflict) {
        return res.status(409).json({ success: false, error: { code: 'TERM_DATE_CONFLICT', message: conflict } });
      }

      const term = await insertTerm(req.params.sessionId, req.params.schoolId, name, start_date, end_date);
      await logAudit({
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'TERM_CREATED',
        entity: 'terms',
        entityId: term.id,
        newValue: { name, start_date, end_date, session_id: req.params.sessionId },
      }).catch(() => {});

      return res.status(201).json({ success: true, data: term });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/sessions/:sessionId/terms/:termId ────────────────────────
// Corrects a term's name or dates. School calendars shift after onboarding, and
// before this route existed the only way to change a term was direct DB access.

router.patch(
  '/:schoolId/sessions/:sessionId/terms/:termId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId, sessionId, termId } = req.params;

      const existing = await findTermById(termId, sessionId, schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Term not found' } });
      }

      // Validate the resulting date range, not just the supplied fields — a caller may
      // move only one edge and still invert or overlap.
      const nextStart = parsed.data.start_date ?? existing.start_date;
      const nextEnd = parsed.data.end_date ?? existing.end_date;
      const conflict = await findTermDateConflict(sessionId, schoolId, nextStart, nextEnd, termId);
      if (conflict) {
        return res.status(409).json({ success: false, error: { code: 'TERM_DATE_CONFLICT', message: conflict } });
      }

      const term = await updateTerm(termId, sessionId, schoolId, parsed.data);
      if (!term) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Term not found' } });
      }

      await logAudit({
        schoolId,
        userId: req.user!.user_id,
        actionType: 'TERM_UPDATED',
        entity: 'terms',
        entityId: termId,
        oldValue: { name: existing.name, start_date: existing.start_date, end_date: existing.end_date },
        newValue: { name: term.name, start_date: term.start_date, end_date: term.end_date },
      }).catch(() => {});

      return res.json({ success: true, data: term });
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

// ── PATCH /:schoolId/sessions/:sessionId/terms/:termId/activate ──────────────────

router.patch(
  '/:schoolId/sessions/:sessionId/terms/:termId/activate',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.body.confirm !== true) {
        return res.status(400).json({
          success: false,
          error: { code: 'CONFIRMATION_REQUIRED', message: 'Body must include { "confirm": true } to activate a term' },
        });
      }

      const session = await findSessionById(req.params.sessionId, req.params.schoolId);
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
      }
      // getCurrentContext requires both the session AND the term to be current —
      // activating a term in a non-current session would silently do nothing.
      if (!session.is_current) {
        return res.status(409).json({
          success: false,
          error: { code: 'SESSION_NOT_CURRENT', message: 'Activate this term\'s academic session before activating one of its terms' },
        });
      }

      const term = await findTermById(req.params.termId, req.params.sessionId, req.params.schoolId);
      if (!term) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Term not found' } });
      }

      await activateTerm(req.params.schoolId, req.params.sessionId, req.params.termId);

      // Bust the cache so the next current-context request is fresh
      if (redis) await redis.del(`ctx:${req.params.schoolId}`);

      await logAudit({
        schoolId:   req.params.schoolId,
        userId:     req.user!.user_id,
        actionType: 'TERM_ACTIVATED',
        entity:     'terms',
        entityId:   req.params.termId,
        newValue:   { term_id: req.params.termId, session_id: req.params.sessionId, name: term.name },
      });

      return res.json({ success: true, data: { message: 'Term activated' } });
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
