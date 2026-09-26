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
  getClassSubjectStatuses,
  markSubjectSubmitted,
  returnSubjectsToDraft,
} from '../db/queries/results';
import { computeClassResults } from '../services/resultEngine';
import { startReportCardBatch, getJob, signReportCardAsset } from '../services/reportCardService';
import { getReportCardsForClass, publishReportCards } from '../db/queries/reportCards';
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
  // Student-level (class result) transitions. Subject-level draft → submitted
  // lives in subject_result_status (AUDIT C-2). 'submitted' is a legacy
  // student-level value that migration 029 converts to 'draft'.
  const allowed: Record<string, readonly string[]> = {
    draft:     ['approved'],
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

// Same shape as classTermSchema, named separately so the query-param route reads
// clearly at its call site.
const classSummaryQuerySchema = z.object({
  class_id: z.string().uuid(),
  term_id:  z.string().uuid(),
});

const returnSchema = z.object({
  class_id:   z.string().uuid(),
  term_id:    z.string().uuid(),
  subject_id: z.string().uuid().optional(), // omit to return every subject in the class
  reason:     z.string().min(10, 'Reason must be at least 10 characters'),
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

      if (completion.no_config) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_ASSESSMENT_CONFIG', message: 'This school has no assessment configuration set up.' },
        });
      }

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

      // A class whose result is already approved/published cannot take new submissions.
      const students = await getStudentsInClassWithStatus(class_id, term_id, schoolId);
      const finalised = students.filter(s => ['approved', 'published'].includes(s.current_status ?? ''));
      if (finalised.length > 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'TRANSITION_BLOCKED',
            message: 'This class result has already been approved or published. Ask the principal to return it first.',
          },
        });
      }

      // Per class + subject (AUDIT C-2). Idempotent: re-submitting is a no-op.
      const changed = await markSubjectSubmitted(schoolId, class_id, subject_id, term_id, userId);

      if (changed) {
        await logAudit({
          supportSession: req.supportSession,
          schoolId,
          userId,
          actionType: 'RESULTS_SUBMITTED',
          entity:     'subject_result_status',
          entityId:   class_id,
          newValue:   { term_id, subject_id, student_count: students.length },
        });
      }

      return res.json({
        success: true,
        data: {
          submitted_students: students.length,
          already_submitted: !changed,
          message: 'Subject submitted for approval. Score editing is now locked for this subject.',
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

// ── (2b) GET /:schoolId/results/class-summary ─────────────────────────────────
// The numbers behind an approval decision.
//
// getApprovalDashboard returns subject name, teacher name and a scored/total count.
// A principal approving from that alone is confirming that entry is COMPLETE, not
// that it is CORRECT — a clerical check presented as a judgement. The return dialog
// even suggests "Exam scores for 3 students look swapped", a call the screen gave no
// way to make. This serves the per-student weighted totals, grades and positions that
// the question actually requires; computeClassResults already computes them for
// report cards, so the same aggregation backs approval, the report card and the
// principal's student list, and the three cannot disagree.
//
// Deliberately NOT publish-gated. Doctrine 5's gate exists to stop parents and
// students seeing unapproved marks; a principal reviewing marks BEFORE approving
// them must see exactly that unapproved state, which is why this route is restricted
// to principal and super_admin at the call site rather than relying on the file's
// permissive requireSchoolAccess (doctrine 1). Teachers are excluded on purpose: this
// spans every subject in the class, while a teacher's own subject remains available
// through GET /scores/class-sheet.

router.get(
  '/:schoolId/results/class-summary',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classSummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
        });
      }
      const { class_id, term_id } = parsed.data;
      const schoolId = req.params.schoolId;

      // Validate the target, not just the caller (doctrine 3): computeClassResults
      // filters by school_id, but a class or term from another tenant would otherwise
      // come back as an empty result rather than a 404.
      const [cls, term] = await Promise.all([
        pool.query(`SELECT 1 FROM classes WHERE id = $1 AND school_id = $2`, [class_id, schoolId]),
        pool.query(`SELECT 1 FROM terms WHERE id = $1 AND school_id = $2`, [term_id, schoolId]),
      ]);
      if (cls.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found' } });
      }
      if (term.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Term not found' } });
      }

      const result = await computeClassResults(class_id, term_id, schoolId);
      return res.json({ success: true, data: result });
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

      // Every subject taught in this class this term must be submitted (AUDIT C-2).
      const [assignments, subjectStatuses] = await Promise.all([
        getClassSubjectAssignments(class_id, term_id, schoolId),
        getClassSubjectStatuses(class_id, term_id, schoolId),
      ]);
      if (assignments.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_SUBJECTS', message: 'No subjects are assigned to this class for the selected term' },
        });
      }
      const seenSubjects = new Set<string>();
      const pendingSubjects = assignments.filter(a => {
        if (seenSubjects.has(a.subject_id)) return false;
        seenSubjects.add(a.subject_id);
        return subjectStatuses.get(a.subject_id)?.status !== 'submitted';
      });
      if (pendingSubjects.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NOT_ALL_SUBMITTED',
            message: `${pendingSubjects.length} subject(s) have not been submitted. All subjects for the class must be submitted before approval.`,
            not_submitted: pendingSubjects.map(a => ({
              subject_id:   a.subject_id,
              subject_name: a.subject_name,
              teacher_name: `${a.teacher_first_name} ${a.teacher_last_name}`.trim(),
            })),
          },
        });
      }

      // Student-level transition: anything already approved/published blocks re-approval.
      for (const s of students) {
        const transitionErr = validateStatusTransition(s.current_status, 'approved');
        if (transitionErr) {
          return res.status(409).json({
            success: false,
            error: { code: 'INVALID_TRANSITION', message: transitionErr },
          });
        }
      }

      const studentIds = students.map(s => s.student_id);
      await batchUpsertStatuses(studentIds, schoolId, term_id, 'approved', userId, ['draft', 'submitted']);

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

      // Release any already-generated report cards for these students — this is
      // the only place report_cards.is_published ever flips to TRUE. Without it,
      // the parent/student report-card PDF routes (which gate on is_published = TRUE)
      // would never return a report card, no matter what the result_status says.
      // NOTE: the PDF is not the only thing publishing releases. The parent/student
      // JSON score routes gate on result_status = 'published' (AUDIT R10-H1), so this
      // batchUpsertStatuses call above is what makes scores visible to them at all.
      await publishReportCards(schoolId, term_id, studentIds);

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

      const { class_id, term_id, subject_id, reason } = parsed.data;
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

      // Student-level: approved (or legacy submitted) → draft
      const returnable = students.filter(s => (s.current_status ?? 'draft') !== 'draft');
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

      // Subject-level: submitted → draft (one subject, or all)
      const resetSubjects = await returnSubjectsToDraft(schoolId, class_id, term_id, userId, reason, subject_id);

      if (toResetIds.length === 0 && resetSubjects.length === 0) {
        return res.status(409).json({
          success: false,
          error: { code: 'NOTHING_TO_RETURN', message: 'Nothing to return — no submitted subjects or approved results for this selection.' },
        });
      }

      // Notify all teachers assigned to this class+term via audit log
      const classTeachers = await getTeachersForClass(class_id, term_id, schoolId);
      let teachers = classTeachers;
      if (subject_id) {
        const assignments = await getClassSubjectAssignments(class_id, term_id, schoolId);
        const ids = new Set(assignments.filter(a => a.subject_id === subject_id).map(a => a.teacher_id));
        teachers = classTeachers.filter(t => ids.has(t.teacher_id));
      }

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
          subject_id: subject_id ?? null,
          reset_subject_ids: resetSubjects,
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
          reset_subjects: resetSubjects.length,
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
      const signedCards = await Promise.all(
        cards.map(async card => ({
          ...card,
          pdf_url: card.pdf_url ? await signReportCardAsset(card.pdf_url) : null,
        }))
      );
      return res.json({ success: true, data: signedCards });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
