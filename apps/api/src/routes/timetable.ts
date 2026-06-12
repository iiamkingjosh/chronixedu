import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { getActiveTerm } from '../db/queries/roster';
import {
  insertSlot,
  findClassClash,
  findTeacherClash,
  getClassTimetable,
  getTeacherTimetable,
  findSlotById,
  deleteSlot,
} from '../db/queries/timetable';

const router = Router();

// ── Middleware ─────────────────────────────────────────────────────────────────

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

// ── Schemas ────────────────────────────────────────────────────────────────────

const slotSchema = z.object({
  class_id: z.string().uuid(),
  term_id: z.string().uuid(),
  day_of_week: z.number().int().min(1).max(7),
  period_number: z.number().int().min(1).max(10),
  subject_id: z.string().uuid(),
  teacher_id: z.string().uuid(),
});

const termQuerySchema = z.object({
  term_id: z.string().uuid().optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function resolveTermId(schoolId: string, termIdFromQuery?: string): Promise<string | null> {
  if (termIdFromQuery) return termIdFromQuery;
  const activeTerm = await getActiveTerm(schoolId);
  return activeTerm?.id ?? null;
}

// ── POST /:schoolId/timetable ──────────────────────────────────────────────────

router.post(
  '/:schoolId/timetable',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = slotSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const { class_id, term_id, day_of_week, period_number, subject_id, teacher_id } = parsed.data;

      const classClash = await findClassClash(schoolId, class_id, term_id, day_of_week, period_number);
      if (classClash) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'CLASS_CLASH',
            message: `${classClash.class_name} already has ${classClash.subject_name} scheduled at this time`,
          },
        });
      }

      const teacherClash = await findTeacherClash(schoolId, teacher_id, term_id, day_of_week, period_number);
      if (teacherClash) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'TEACHER_CLASH',
            message: `${teacherClash.teacher_name} is already teaching ${teacherClash.class_name} at this time`,
          },
        });
      }

      const slot = await insertSlot(schoolId, { class_id, term_id, day_of_week, period_number, subject_id, teacher_id });
      return res.status(201).json({ success: true, data: slot });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/timetable/class/:classId ────────────────────────────────────

router.get(
  '/:schoolId/timetable/class/:classId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId, classId } = req.params;
      const termId = await resolveTermId(schoolId, parsed.data.term_id);
      if (!termId) {
        return res.json({ success: true, data: [] });
      }

      const slots = await getClassTimetable(schoolId, classId, termId);
      return res.json({ success: true, data: slots });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/timetable/teacher/:teacherId ────────────────────────────────

router.get(
  '/:schoolId/timetable/teacher/:teacherId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, teacherId } = req.params;

      if (req.user!.role === 'teacher' && req.user!.user_id !== teacherId) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const termId = await resolveTermId(schoolId, parsed.data.term_id);
      if (!termId) {
        return res.json({ success: true, data: [] });
      }

      const slots = await getTeacherTimetable(schoolId, teacherId, termId);
      return res.json({ success: true, data: slots });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/timetable/:slotId ────────────────────────────────────────

router.delete(
  '/:schoolId/timetable/:slotId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, slotId } = req.params;

      const slot = await findSlotById(slotId, schoolId);
      if (!slot) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Timetable slot not found' } });
      }

      await deleteSlot(slotId, schoolId);
      return res.json({ success: true, data: { id: slotId } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
