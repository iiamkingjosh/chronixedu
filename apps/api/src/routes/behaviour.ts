import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { logAudit } from '../db/queries/auditLog';
import { getActiveTerm, findClassById } from '../db/queries/roster';
import { findStudentById, findStudentByUserId } from '../db/queries/students';
import { isParentLinkedToStudent } from '../db/queries/parents';
import {
  createBehaviourRecord,
  getStudentBehaviourHistory,
  getStudentIncidentCount,
  getSchoolBehaviourSummary,
} from '../db/queries/behaviour';

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

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  student_id: z.string().uuid(),
  class_id: z.string().uuid(),
  incident_type: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  sanction: z.string().max(1000).optional().nullable(),
  severity: z.enum(['minor', 'serious', 'suspension']),
  date: z.string().regex(datePattern, 'date must be in YYYY-MM-DD format').optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── POST /:schoolId/behaviour ───────────────────────────────────────────────────

router.post(
  '/:schoolId/behaviour',
  verifyToken,
  requireSchoolAccess,
  requireRole('teacher', 'principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const { student_id, class_id, incident_type, description, sanction, severity, date } = parsed.data;

      const student = await findStudentById(student_id, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const cls = await findClassById(class_id, schoolId);
      if (!cls) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }

      const term = await getActiveTerm(schoolId);
      if (!term) {
        return res.status(404).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school.' } });
      }

      const record = await createBehaviourRecord({
        school_id: schoolId,
        student_id,
        term_id: term.id,
        class_id,
        incident_type,
        description: description ?? null,
        sanction: sanction ?? null,
        severity,
        reported_by: req.user!.user_id,
        date: date ?? todayDate(),
      });

      // Suspensions notify the parent immediately (parent_notified_at already set on the
      // record); other severities are queued via the audit log, mirroring the
      // PARENT_NOTIFICATION_QUEUED convention used for attendance alerts.
      logAudit({
        schoolId,
        userId: req.user!.user_id,
        actionType: severity === 'suspension' ? 'PARENT_NOTIFICATION_SENT' : 'PARENT_NOTIFICATION_QUEUED',
        entity: 'behaviour_records',
        entityId: record.id,
        newValue: { student_id, notification_type: 'behaviour_incident', severity, incident_type },
      }).catch(() => {
        // Non-critical — do not surface notification errors to the caller
      });

      return res.status(201).json({ success: true, data: record });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/behaviour/students/:studentId — full history (staff) ────────

router.get(
  '/:schoolId/behaviour/students/:studentId',
  verifyToken,
  requireSchoolAccess,
  requireRole('teacher', 'principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, studentId } = req.params;

      const student = await findStudentById(studentId, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const termId = typeof req.query.term_id === 'string' ? req.query.term_id : undefined;
      const records = await getStudentBehaviourHistory(studentId, schoolId, termId);
      return res.json({ success: true, data: records });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/behaviour/students/:studentId/summary — parent / student ────

router.get(
  '/:schoolId/behaviour/students/:studentId/summary',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'student', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, studentId } = req.params;
      const user = req.user!;

      if (user.role === 'parent') {
        const linked = await isParentLinkedToStudent(user.user_id, studentId);
        if (!linked) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You are not linked to this student' } });
        }
      }

      if (user.role === 'student') {
        const own = await findStudentByUserId(user.user_id, schoolId);
        if (!own || own.id !== studentId) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const term = await getActiveTerm(schoolId);
      if (!term) {
        return res.json({ success: true, data: { term_id: null, term_name: null, incident_count: 0 } });
      }

      const incident_count = await getStudentIncidentCount(studentId, schoolId, term.id);
      return res.json({ success: true, data: { term_id: term.id, term_name: term.name, incident_count } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/behaviour/summary — principal dashboard ──────────────────────

router.get(
  '/:schoolId/behaviour/summary',
  verifyToken,
  requireSchoolAccess,
  requireRole('principal', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      const term = await getActiveTerm(schoolId);
      if (!term) {
        return res.json({
          success: true,
          data: { term_id: null, term_name: null, total: 0, by_severity: { minor: 0, serious: 0, suspension: 0 }, recent: [] },
        });
      }

      const summary = await getSchoolBehaviourSummary(schoolId, term.id);
      return res.json({ success: true, data: { term_id: term.id, term_name: term.name, ...summary } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
