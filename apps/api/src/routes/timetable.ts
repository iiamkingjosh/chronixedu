import { Router, Request, Response, NextFunction } from 'express';
import { logAudit } from '../db/queries/auditLog';
import { clientIp } from '../middleware/clientIp';
import { logger } from '../config/logger';
import { z } from 'zod';
import { verifyToken } from '../middleware/auth';
import { requireCapability } from '../middleware/requireCapability';
import { getActiveTerm, rosterTargetMissing } from '../db/queries/roster';
import { findUserById } from '../db/queries/users';
import {
  insertSlot,
  findClassClash,
  findTeacherClash,
  getClassTimetable,
  getTeacherTimetable,
  findSlotById,
  deleteSlot,
  getStudentClassIds,
} from '../db/queries/timetable';

const router = Router();


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

/**
 * AUDIT Round 10 L-06: both GET routes used to return `data: []` when there was no
 * active term, which is indistinguishable from "this term has no slots yet". A blank
 * timetable then gave the viewer no idea whether the school had forgotten to activate
 * a term or simply not built the schedule. Callers now get an explicit term_id: null
 * plus a reason, so the UI can say which it is.
 */
function emptyTimetable(reason: 'NO_ACTIVE_TERM') {
  return { term_id: null, reason, slots: [] as unknown[] };
}

// ── POST /:schoolId/timetable ──────────────────────────────────────────────────

router.post(
  '/:schoolId/timetable',
  verifyToken,
  requireCapability('timetable.manage'),
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

      const teacher = await findUserById(teacher_id, schoolId);
      if (!teacher || teacher.role !== 'teacher') {
        return res.status(404).json({ success: false, error: { code: 'TEACHER_NOT_FOUND', message: 'Teacher not found in this school' } });
      }

      const missing = await rosterTargetMissing(schoolId, { class_id, subject_id, term_id });
      if (missing) {
        return res.status(404).json({ success: false, error: { code: missing, message: ({ CLASS_NOT_FOUND: 'Class not found in this school', SUBJECT_NOT_FOUND: 'Subject not found in this school', TERM_NOT_FOUND: 'Term not found in this school' })[missing] } });
      }

      const slot = await insertSlot(schoolId, { class_id, term_id, day_of_week, period_number, subject_id, teacher_id });
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'TIMETABLE_SLOT_CREATED',
        entity: 'timetable_slots',
        entityId: slot.id,
        newValue: slot,
      }).catch(err => {
        // Logged, never swallowed: a sensitive write without its audit row must be visible (doctrine 10).
        logger.error('audit_write_failed', { action: 'TIMETABLE_SLOT_CREATED', error: err instanceof Error ? err.message : String(err) });
      });
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
  requireCapability('school.member'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId, classId } = req.params;

      // AUDIT Round 10 L-07: classId came straight from the path with no check, so any
      // authenticated member of the school could read any class's timetable. Staff
      // legitimately need any class; a student may only read their own.
      if (req.user!.role === 'student') {
        const own = await getStudentClassIds(req.user!.user_id, schoolId);
        if (!own.includes(classId)) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const termId = await resolveTermId(schoolId, parsed.data.term_id);
      if (!termId) {
        return res.json({ success: true, data: emptyTimetable('NO_ACTIVE_TERM') });
      }

      const slots = await getClassTimetable(schoolId, classId, termId);
      return res.json({ success: true, data: { term_id: termId, reason: null, slots } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/timetable/teacher/:teacherId ────────────────────────────────

router.get(
  '/:schoolId/timetable/teacher/:teacherId',
  verifyToken,
  requireCapability('school.member'),
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
        return res.json({ success: true, data: emptyTimetable('NO_ACTIVE_TERM') });
      }

      const slots = await getTeacherTimetable(schoolId, teacherId, termId);
      return res.json({ success: true, data: { term_id: termId, reason: null, slots } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/timetable/:slotId ────────────────────────────────────────

router.delete(
  '/:schoolId/timetable/:slotId',
  verifyToken,
  requireCapability('timetable.manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, slotId } = req.params;

      const slot = await findSlotById(slotId, schoolId);
      if (!slot) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Timetable slot not found' } });
      }

      await deleteSlot(slotId, schoolId);
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'TIMETABLE_SLOT_DELETED',
        entity: 'timetable_slots',
        entityId: slotId,
        oldValue: slot,
      }).catch(err => {
        // Logged, never swallowed: a sensitive write without its audit row must be visible (doctrine 10).
        logger.error('audit_write_failed', { action: 'TIMETABLE_SLOT_DELETED', error: err instanceof Error ? err.message : String(err) });
      });
      return res.json({ success: true, data: { id: slotId } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
