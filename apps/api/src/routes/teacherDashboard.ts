import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken } from '../middleware/auth';
import { requireCapability } from '../middleware/requireCapability';
import { getActiveTerm } from '../db/queries/roster';
import {
  getTeacherOverview,
  getTeacherScoreEntryStatus,
  getStudentsInClassWithAverages,
  getTeacherNotifications,
} from '../db/queries/dashboard';
import pool from '../db/client';

const router = Router();

// Resolve active term or respond 404
async function resolveActiveTerm(
  schoolId: string,
  res: Response
): Promise<{ id: string; name: string; session_id: string } | null> {
  const term = await getActiveTerm(schoolId);
  if (!term) {
    res.status(404).json({
      success: false,
      error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school.' },
    });
    return null;
  }
  return term;
}

// ── (1) GET /overview ─────────────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/teacher/overview',
  verifyToken,
  requireCapability('teacher.workspace'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const teacherId    = req.user!.user_id;

      const term = await resolveActiveTerm(schoolId, res);
      if (!term) return;

      const data = await getTeacherOverview(teacherId, schoolId, term.id);
      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (2) GET /score-entry-status ───────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/teacher/score-entry-status',
  verifyToken,
  requireCapability('teacher.workspace'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const teacherId    = req.user!.user_id;

      const term = await resolveActiveTerm(schoolId, res);
      if (!term) return;

      const data = await getTeacherScoreEntryStatus(teacherId, schoolId, term.id);
      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (3) GET /my-students?class_id= ───────────────────────────────────────────

const myStudentsSchema = z.object({ class_id: z.string().uuid() });

router.get(
  '/:schoolId/dashboard/teacher/my-students',
  verifyToken,
  requireCapability('teacher.workspace'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const teacherId    = req.user!.user_id;

      const parsed = myStudentsSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: class_id (UUID)' },
        });
      }

      const { class_id } = parsed.data;

      const term = await resolveActiveTerm(schoolId, res);
      if (!term) return;

      // Verify the teacher is assigned to at least one subject in this class
      const assigned = await pool.query(
        `SELECT id FROM teacher_assignments
         WHERE teacher_id = $1 AND class_id = $2 AND school_id = $3 AND term_id = $4
         LIMIT 1`,
        [teacherId, class_id, schoolId, term.id]
      );
      if (assigned.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this class for the active term.' },
        });
      }

      const data = await getStudentsInClassWithAverages(class_id, schoolId, term.id);
      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (4) GET /notifications ────────────────────────────────────────────────────

router.get(
  '/:schoolId/dashboard/teacher/notifications',
  verifyToken,
  requireCapability('teacher.workspace'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const teacherId    = req.user!.user_id;

      const data = await getTeacherNotifications(teacherId, schoolId);
      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
