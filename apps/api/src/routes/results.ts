import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { verifyToken, requireRole } from '../middleware/auth';
import { logAudit } from '../db/queries/auditLog';
import {
  checkSubjectCompletion,
  getStudentsInClassWithStatus,
  batchUpsertStatuses,
  getClassSubjectAssignments,
  getTeachersForClass,
  getApprovalDashboard,
} from '../db/queries/results';
import { startReportCardBatch, getJob } from '../services/reportCardService';
import { getReportCardsForClass } from '../db/queries/reportCards';
import pool from '../db/client';

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

// ── Status transition guard ────────────────────────────────────────────────────

/**
 * Returns an error message string if the transition is invalid, null if allowed.
 * Treat null current (no result_status row) as 'draft'.
 */
function validateStatusTransition(current: string | null, next: string): string | null {
  const from = current ?? 'draft';
  const allowed: Record<string, readonly string[]> = {
    draft:     ['submitted'],
    submitted: ['approved', 'draft'],
    approved:  ['published', 'draft'],
    published: [],
  };
  const valid = allowed[from] ?? [];
  if (!valid.includes(next)) {
    return `Cannot transition from '${from}' to '${next}'`;
  }
  return null;
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const submitSchema = z.object({
  class_id:   z.string().uuid(),
  subject_id: z.string().uuid(),
  term_id:    z.string().uuid(),
});

const classTermSchema = z.object({
  class_id: z.string().uuid(),
  term_id:  z.string().uuid(),
});

const returnSchema = z.object({
  class_id: z.string().uuid(),
  term_id:  z.string().uuid(),
  reason:   z.string().min(10, 'Reason must be at least 10 characters'),
});

// ── (1) POST /:schoolId/results/submit ────────────────────────────────────────
// Teacher submits their subject's scores for a class+term.

router.post(
  '/:schoolId/results/submit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
        });
      }

      const { class_id, subject_id, term_id } = parsed.data;
      const userId   = req.user!.user_id;
      const schoolId = req.params.schoolId;
      const role     = req.user!.role ?? '';

      // Assignment check — super_admin and principal bypass
      if (!['super_admin', 'principal'].includes(role)) {
        const assigned = await pool.query(
          `SELECT id FROM teacher_assignments
           WHERE teacher_id = $1 AND subject_id = $2 AND class_id = $3 AND term_id = $4 AND school_id = $5`,
          [userId, subject_id, class_id, term_id, schoolId]
        );
        if (assigned.rows.length === 0) {
          return res.status(403).json({
            success: false,
            error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this subject and class for the selected term' },
          });
        }
      }

      // Validate score completeness
      const completion = await checkSubjectCompletion(schoolId, class_id, subject_id, term_id);

      if (completion.total_students === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_STUDENTS', message: 'No students are enrolled in this class for the selected term' },
        });
      }

      if (completion.missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INCOMPLETE_SCORES',
            message: `${completion.missing.length} student(s) have missing scores. All components must be scored before submission.`,
            missing: completion.missing,
          },
        });
      }

      // Get enrolled students and validate transitions
      const students  = await getStudentsInClassWithStatus(class_id, term_id, schoolId);
      const studentIds = students.map(s => s.student_id);

      // Validate that no student is in an un-submittable state (approved/published blocks submit)
      const blocked = students.filter(s => {
        const err = validateStatusTransition(s.current_status, 'submitted');
        // submitted → submitted is not in allowed transitions, but we allow re-submit as idempotent
        return err !== null && (s.current_status ?? 'draft') !== 'submitted';
      });
      if (blocked.length > 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'TRANSITION_BLOCKED',
            message: 'Some students have results that are already approved or published and cannot be re-submitted',
            blocked: blocked.map(s => ({
              student_id: s.student_id,
              name: `${s.first_name} ${s.last_name}`,
              current_status: s.current_status,
            })),
          },
        });
      }

      // Update draft → submitted (skip students already at submitted/approved/published)
      await batchUpsertStatuses(studentIds, schoolId, term_id, 'submitted', userId, ['draft']);

      await logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId,
        actionType: 'RESULTS_SUBMITTED',
        entity:     'result_status',
        entityId:   class_id,
        newValue:   { term_id, subject_id, student_count: studentIds.length },
      });

      return res.json({
        success: true,
        data: {
          submitted_students: studentIds.length,
          message: 'Results submitted successfully. Score editing is now locked for these students.',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (2) GET /:schoolId/results/approval-dashboard ─────────────────────────────

router.get(
  '/:schoolId/results/approval-dashboard',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const termId = req.query.term_id as string | undefined;
      if (!termId || !/^[0-9a-f-]{36}$/.test(termId)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const dashboard = await getApprovalDashboard(req.params.schoolId, termId);
      return res.json({ success: true, data: dashboard });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (3) POST /:schoolId/results/approve ───────────────────────────────────────
// Principal approves results for a class+term. All students must be 'submitted'.

router.post(
  '/:schoolId/results/approve',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classTermSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
        });
      }

      const { class_id, term_id } = parsed.data;
      const userId   = req.user!.user_id;
      const schoolId = req.params.schoolId;

      const students = await getStudentsInClassWithStatus(class_id, term_id, schoolId);
      if (students.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_STUDENTS', message: 'No students enrolled in this class for the selected term' },
        });
      }

      // All students must be 'submitted' — reject if any are in another status
      const notSubmitted = students.filter(s => (s.current_status ?? 'draft') !== 'submitted');
      if (notSubmitted.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NOT_ALL_SUBMITTED',
            message: `${notSubmitted.length} student(s) have not been submitted. All subjects for the class must be submitted before approval.`,
            not_submitted: notSubmitted.map(s => ({
              student_id:     s.student_id,
              name:           `${s.first_name} ${s.last_name}`,
              current_status: s.current_status ?? 'draft',
            })),
          },
        });
      }

      // Validate transition for the batch
      const transitionErr = validateStatusTransition('submitted', 'approved');
      if (transitionErr) {
        return res.status(409).json({
          success: false,
          error: { code: 'INVALID_TRANSITION', message: transitionErr },
        });
      }

      const studentIds = students.map(s => s.student_id);
      await batchUpsertStatuses(studentIds, schoolId, term_id, 'approved', userId, ['submitted']);

      await logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId,
        actionType: 'RESULTS_APPROVED',
        entity:     'result_status',
        entityId:   class_id,
        newValue:   { term_id, student_count: studentIds.length },
      });

      return res.json({
        success: true,
        data: {
          approved_students: studentIds.length,
          message: 'Results approved. They are now locked and can be published.',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (4) POST /:schoolId/results/publish ───────────────────────────────────────
// Principal publishes approved results. Queues parent notifications.

router.post(
  '/:schoolId/results/publish',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classTermSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
        });
      }

      const { class_id, term_id } = parsed.data;
      const userId   = req.user!.user_id;
      const schoolId = req.params.schoolId;

      const students = await getStudentsInClassWithStatus(class_id, term_id, schoolId);
      if (students.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_STUDENTS', message: 'No students enrolled in this class for the selected term' },
        });
      }

      // All students must be 'approved'
      const notApproved = students.filter(s => (s.current_status ?? 'draft') !== 'approved');
      if (notApproved.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NOT_ALL_APPROVED',
            message: `${notApproved.length} student(s) are not in 'approved' status. Results must be approved before publishing.`,
            not_approved: notApproved.map(s => ({
              student_id:     s.student_id,
              name:           `${s.first_name} ${s.last_name}`,
              current_status: s.current_status ?? 'draft',
            })),
          },
        });
      }

      const studentIds = students.map(s => s.student_id);
      await batchUpsertStatuses(studentIds, schoolId, term_id, 'published', userId, ['approved']);

      await logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId,
        actionType: 'RESULTS_PUBLISHED',
        entity:     'result_status',
        entityId:   class_id,
        newValue:   { term_id, student_count: studentIds.length },
      });

      // Fire-and-forget: queue parent notification job via audit_log
      // A background worker reads PARENT_NOTIFICATION_QUEUED entries and dispatches messages
      logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId,
        actionType: 'PARENT_NOTIFICATION_QUEUED',
        entity:     'result_status',
        entityId:   class_id,
        newValue: {
          term_id,
          notification_type: 'results_published',
          student_ids: studentIds,
        },
      }).catch(() => {
        // Non-critical — do not surface notification errors to the caller
      });

      return res.json({
        success: true,
        data: {
          published_students: studentIds.length,
          message: 'Results published. Parent notifications have been queued.',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (5) POST /:schoolId/results/return ────────────────────────────────────────
// Principal returns results to draft for correction. Requires a reason.

router.post(
  '/:schoolId/results/return',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = returnSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
        });
      }

      const { class_id, term_id, reason } = parsed.data;
      const userId   = req.user!.user_id;
      const schoolId = req.params.schoolId;

      const students = await getStudentsInClassWithStatus(class_id, term_id, schoolId);
      if (students.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_STUDENTS', message: 'No students enrolled in this class for the selected term' },
        });
      }

      // Published results cannot be returned — published is final
      const published = students.filter(s => s.current_status === 'published');
      if (published.length > 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'RESULTS_PUBLISHED',
            message: 'Published results cannot be returned. Results have already been released to parents.',
          },
        });
      }

      // Validate transition: any non-draft student must support → draft
      const returnable = students.filter(s => {
        const status = s.current_status ?? 'draft';
        return status !== 'draft'; // draft → draft is a no-op, skip
      });

      for (const student of returnable) {
        const err = validateStatusTransition(student.current_status, 'draft');
        if (err) {
          return res.status(409).json({
            success: false,
            error: { code: 'INVALID_TRANSITION', message: err },
          });
        }
      }

      const toResetIds = returnable.map(s => s.student_id);
      if (toResetIds.length > 0) {
        await batchUpsertStatuses(toResetIds, schoolId, term_id, 'draft', userId);
      }

      // Notify all teachers assigned to this class+term via audit log
      const teachers = await getTeachersForClass(class_id, term_id, schoolId);

      await logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId,
        actionType: 'RESULTS_RETURNED',
        entity:     'result_status',
        entityId:   class_id,
        newValue: {
          term_id,
          reason,
          reset_student_count: toResetIds.length,
          notified_teachers: teachers.map(t => ({
            teacher_id: t.teacher_id,
            name:       `${t.teacher_first_name} ${t.teacher_last_name}`.trim(),
          })),
        },
      });

      // Fire-and-forget teacher notification job
      logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId,
        actionType: 'TEACHER_NOTIFICATION_QUEUED',
        entity:     'result_status',
        entityId:   class_id,
        newValue: {
          term_id,
          notification_type: 'results_returned',
          reason,
          teacher_ids: teachers.map(t => t.teacher_id),
        },
      }).catch(() => {});

      return res.json({
        success: true,
        data: {
          reset_students: toResetIds.length,
          message: reason
            ? `Results returned to draft. Teachers have been notified. Reason: ${reason}`
            : 'Results returned to draft. Teachers have been notified.',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (6) POST /:schoolId/results/generate-report-cards ────────────────────────
// Queues async PDF generation for all approved/published students in a class.

const generateSchema = z.object({
  class_id: z.string().uuid(),
  term_id:  z.string().uuid(),
});

router.post(
  '/:schoolId/results/generate-report-cards',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = generateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
        });
      }

      const { class_id, term_id } = parsed.data;
      const schoolId = req.params.schoolId;

      const students = await getStudentsInClassWithStatus(class_id, term_id, schoolId);
      if (students.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_STUDENTS', message: 'No students enrolled in this class for the selected term' },
        });
      }

      // Only generate for students whose results are approved or published
      const eligible = students.filter(
        s => s.current_status === 'approved' || s.current_status === 'published'
      );

      if (eligible.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_ELIGIBLE_STUDENTS',
            message: 'No students have approved or published results. Approve results before generating report cards.',
          },
        });
      }

      const jobId = randomUUID();

      startReportCardBatch(jobId, class_id, term_id, schoolId, eligible);

      return res.status(202).json({
        success: true,
        data: {
          job_id:          jobId,
          total_students:  eligible.length,
          message:         'Report card generation started. Poll the job status endpoint to track progress.',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (7) GET /:schoolId/results/report-card-jobs/:jobId ────────────────────────

router.get(
  '/:schoolId/results/report-card-jobs/:jobId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = getJob(req.params.jobId);
      if (!job || job.schoolId !== req.params.schoolId) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      return res.json({ success: true, data: job });
    } catch (err) {
      return next(err);
    }
  }
);

// ── (8) GET /:schoolId/results/report-cards ───────────────────────────────────
// Lists generated report cards for a class+term (used to show generation status).

const reportCardsQuerySchema = z.object({
  class_id: z.string().uuid(),
  term_id:  z.string().uuid(),
});

router.get(
  '/:schoolId/results/report-cards',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reportCardsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query params: class_id, term_id (UUIDs)' },
        });
      }

      const { class_id, term_id } = parsed.data;
      const cards = await getReportCardsForClass(class_id, term_id, req.params.schoolId);
      return res.json({ success: true, data: cards });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
