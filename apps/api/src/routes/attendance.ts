import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { logAudit } from '../db/queries/auditLog';
import { findClassById } from '../db/queries/roster';
import { findStudentById } from '../db/queries/students';
import {
  findTermForDate,
  bulkUpsertAttendance,
  countRecentAbsences,
  hasUnresolvedAlert,
  insertAttendanceAlert,
  getClassAttendanceForDate,
  getStudentAttendanceHistory,
  getMonthlySummary,
  getClassTermSummary,
  listUnresolvedAlerts,
  LOW_ATTENDANCE_ALERT_TYPE,
  AttendanceAlertRow,
} from '../db/queries/attendance';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────────

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const markSchema = z.object({
  class_id: z.string().uuid(),
  date:     z.string().regex(datePattern, 'date must be in YYYY-MM-DD format'),
  entries:  z.array(z.object({
    student_id: z.string().uuid(),
    status:     z.enum(['present', 'absent', 'late', 'excused']),
  })).min(1),
});

const classQuerySchema = z.object({
  class_id: z.string().uuid(),
  date:     z.string().regex(datePattern, 'date must be in YYYY-MM-DD format'),
});

const studentQuerySchema = z.object({
  term_id: z.string().uuid(),
});

const monthlyQuerySchema = z.object({
  class_id: z.string().uuid(),
  month:    z.coerce.number().int().min(1).max(12),
  year:     z.coerce.number().int().min(2000).max(2100),
});

const termQuerySchema = z.object({
  term_id: z.string().uuid(),
});

// ── Middleware: super_admin or any authenticated member of the school ───────────

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

// ── POST /:schoolId/attendance/mark ────────────────────────────────────────────

router.post(
  '/:schoolId/attendance/mark',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = markSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { class_id, date, entries } = parsed.data;
      const schoolId = req.params.schoolId;
      const markedBy = req.user!.user_id;

      const cls = await findClassById(class_id, schoolId);
      if (!cls) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }

      const term = await findTermForDate(schoolId, date);
      if (!term) {
        return res.status(422).json({ success: false, error: { code: 'NO_TERM_FOR_DATE', message: 'No term covers this date for this school' } });
      }

      const saved = await bulkUpsertAttendance(schoolId, class_id, term.id, date, entries, markedBy);

      await logAudit({
        schoolId,
        userId: markedBy,
        actionType: 'ATTENDANCE_MARKED',
        entity: 'attendance',
        entityId: class_id,
        newValue: { class_id, date, term_id: term.id, count: saved.length },
      });

      // Low-attendance alert: 3+ absences in the trailing 7 days (inclusive of the marked date)
      const alerts: AttendanceAlertRow[] = [];
      for (const entry of entries) {
        if (entry.status !== 'absent') continue;

        const recentAbsences = await countRecentAbsences(entry.student_id, schoolId, date);
        if (recentAbsences < 3) continue;

        const alreadyAlerted = await hasUnresolvedAlert(entry.student_id, schoolId, LOW_ATTENDANCE_ALERT_TYPE);
        if (alreadyAlerted) continue;

        const alert = await insertAttendanceAlert(schoolId, entry.student_id, LOW_ATTENDANCE_ALERT_TYPE);
        alerts.push(alert);

        // Fire-and-forget: queue parent notification job via audit_log (background worker dispatches)
        logAudit({
          schoolId,
          userId: markedBy,
          actionType: 'PARENT_NOTIFICATION_QUEUED',
          entity: 'attendance_alerts',
          entityId: alert.id,
          newValue: {
            student_id: entry.student_id,
            notification_type: 'low_attendance',
            recent_absences: recentAbsences,
          },
        }).catch(() => {
          // Non-critical — do not surface notification errors to the caller
        });
      }

      return res.status(201).json({
        success: true,
        data: { saved, term_id: term.id, alerts_triggered: alerts.length, alerts },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/attendance/class ────────────────────────────────────────────

router.get(
  '/:schoolId/attendance/class',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query params: class_id (UUID), date (YYYY-MM-DD)' },
        });
      }

      const { class_id, date } = parsed.data;
      const schoolId = req.params.schoolId;

      const cls = await findClassById(class_id, schoolId);
      if (!cls) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }

      const roster = await getClassAttendanceForDate(class_id, schoolId, date);
      return res.json({ success: true, data: { class: cls, date, roster } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/attendance/student/:studentId ───────────────────────────────

router.get(
  '/:schoolId/attendance/student/:studentId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = studentQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { term_id } = parsed.data;
      const schoolId = req.params.schoolId;

      const student = await findStudentById(req.params.studentId, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const history = await getStudentAttendanceHistory(req.params.studentId, schoolId, term_id);
      return res.json({ success: true, data: history });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/attendance/monthly-summary ──────────────────────────────────

router.get(
  '/:schoolId/attendance/monthly-summary',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = monthlyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query params: class_id (UUID), month (1-12), year' },
        });
      }

      const { class_id, month, year } = parsed.data;
      const schoolId = req.params.schoolId;

      const cls = await findClassById(class_id, schoolId);
      if (!cls) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }

      const summary = await getMonthlySummary(class_id, schoolId, month, year);
      return res.json({ success: true, data: { class: cls, month, year, students: summary } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/attendance/class-summary — school-wide % per class, this term ─

router.get(
  '/:schoolId/attendance/class-summary',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { term_id } = parsed.data;
      const schoolId = req.params.schoolId;

      const summary = await getClassTermSummary(schoolId, term_id);
      return res.json({ success: true, data: { term_id, classes: summary } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/attendance/alerts — chronic absenteeism (unresolved alerts) ──

router.get(
  '/:schoolId/attendance/alerts',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const alerts = await listUnresolvedAlerts(req.params.schoolId);
      return res.json({ success: true, data: alerts });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
