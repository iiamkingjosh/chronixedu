import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { logAudit } from '../db/queries/auditLog';
import { getActiveTerm } from '../db/queries/roster';
import {
  checkTeacherAssigned,
  getResultStatus,
  getExistingScore,
  getEnrolledStudentIds,
  upsertScore,
  bulkUpsertScores,
  getClassSheet,
  getMyPendingAssignments,
  ComponentInfo,
} from '../db/queries/scores';
import { resolveAssessmentConfig } from '../db/queries/assessmentConfig';
import pool from '../db/client';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────────

const entrySchema = z.object({
  student_id:   z.string().uuid(),
  subject_id:   z.string().uuid(),
  class_id:     z.string().uuid(),
  term_id:      z.string().uuid(),
  component_id: z.string().uuid(),
  score:        z.number().min(0),
});

const bulkEntrySchema = z.object({
  subject_id: z.string().uuid(),
  class_id:   z.string().uuid(),
  term_id:    z.string().uuid(),
  entries:    z.array(z.object({
    student_id:   z.string().uuid(),
    component_id: z.string().uuid(),
    score:        z.number().min(0),
  })).min(1),
});

const sheetQuerySchema = z.object({
  class_id:   z.string().uuid(),
  subject_id: z.string().uuid(),
  term_id:    z.string().uuid(),
});

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

// ── POST /:schoolId/scores/entry ───────────────────────────────────────────────

router.post(
  '/:schoolId/scores/entry',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = entrySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { student_id, subject_id, class_id, term_id, component_id, score } = parsed.data;
      const teacherId = req.user!.user_id;

      // (a) Teacher assignment check — super_admin and principal bypass
      if (!['super_admin', 'principal'].includes(req.user!.role ?? '')) {
        const assigned = await checkTeacherAssigned(teacherId, subject_id, class_id, term_id, req.params.schoolId);
        if (!assigned) {
          return res.status(403).json({
            success: false,
            error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this subject and class for the current term' },
          });
        }
      }

      // (b) Enrollment check — the student being scored must actually be
      // enrolled in class_id for this term. checkTeacherAssigned above only
      // proves the teacher owns (subject, class, term); it says nothing
      // about whose student_id was submitted, and class_id itself is never
      // stored on the scores row — without this, a legitimately-assigned
      // teacher could write a score against any student in the school.
      const enrolled = await getEnrolledStudentIds(req.params.schoolId, class_id, term_id, [student_id]);
      if (!enrolled.has(student_id)) {
        return res.status(400).json({
          success: false,
          error: { code: 'STUDENT_NOT_ENROLLED', message: 'This student is not enrolled in the specified class for this term' },
        });
      }

      // (c) Component check — the component must belong to the assessment
      // config actually resolved for this class+subject+term, not merely
      // exist somewhere in the school. Prevents writing a score under a
      // component_id that belongs to a different subject's config.
      const config = await resolveAssessmentConfig(req.params.schoolId, class_id, subject_id, term_id);
      const comp = config?.components.find(c => c.id === component_id) ?? null;
      if (!comp) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Assessment component not found for this class, subject, and term' },
        });
      }
      if (score > Number(comp.max_score)) {
        return res.status(400).json({
          success: false,
          error: { code: 'SCORE_EXCEEDS_MAX', message: `Score ${score} exceeds max_score ${comp.max_score} for component "${comp.name}"` },
        });
      }

      // (d) Result status lock check — submitted/approved/published all block score edits
      const status = await getResultStatus(student_id, term_id, req.params.schoolId);
      if (status && ['submitted', 'approved', 'published'].includes(status)) {
        return res.status(423).json({
          success: false,
          error: { code: 'RESULT_LOCKED', message: `This student's result has been ${status} and scores can no longer be changed` },
        });
      }

      // Capture old score for audit log
      const previous = await getExistingScore(student_id, subject_id, term_id, component_id);

      const saved = await upsertScore(req.params.schoolId, student_id, subject_id, term_id, component_id, score, teacherId);

      await logAudit({
        supportSession: req.supportSession,
        schoolId:   req.params.schoolId,
        userId:     teacherId,
        actionType: previous ? 'SCORE_UPDATED' : 'SCORE_ENTERED',
        entity:     'scores',
        entityId:   saved.id,
        oldValue:   previous ?? undefined,
        newValue:   { score, component_id, student_id },
      });

      return res.status(previous ? 200 : 201).json({ success: true, data: saved });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/scores/class-sheet ──────────────────────────────────────────

router.get(
  '/:schoolId/scores/class-sheet',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = sheetQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query params: class_id, subject_id, term_id (all UUIDs)' },
        });
      }

      const { class_id, subject_id, term_id } = parsed.data;

      // H-02: teachers may only view sheets for classes they are assigned to.
      if (req.user!.role === 'teacher') {
        const assigned = await checkTeacherAssigned(req.user!.user_id, subject_id, class_id, term_id, req.params.schoolId);
        if (!assigned) {
          return res.status(403).json({
            success: false,
            error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this subject and class' },
          });
        }
      }

      const sheet = await getClassSheet(req.params.schoolId, class_id, subject_id, term_id);
      if (!sheet) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Class, subject, or term not found in this school' },
        });
      }

      return res.json({ success: true, data: sheet });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/scores/bulk-entry ──────────────────────────────────────────

router.post(
  '/:schoolId/scores/bulk-entry',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = bulkEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { subject_id, class_id, term_id, entries } = parsed.data;
      const teacherId = req.user!.user_id;

      // (a) Single teacher assignment check for the whole batch
      if (!['super_admin', 'principal'].includes(req.user!.role ?? '')) {
        const assigned = await checkTeacherAssigned(teacherId, subject_id, class_id, term_id, req.params.schoolId);
        if (!assigned) {
          return res.status(403).json({
            success: false,
            error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this subject and class for the current term' },
          });
        }
      }

      // Fetch all unique component_ids and student_ids needed for validation
      const uniqueStudentIds = [...new Set(entries.map(e => e.student_id))];

      // (b) Component map is built from the assessment config actually
      // resolved for this class+subject+term — not from any component that
      // merely exists somewhere in the school — so a component_id borrowed
      // from a different subject's config is rejected as "not found" rather
      // than accepted and written under the wrong subject.
      const config = await resolveAssessmentConfig(req.params.schoolId, class_id, subject_id, term_id);
      const componentMap = new Map<string, ComponentInfo>(
        (config?.components ?? []).map(c => [c.id, c])
      );

      // (c) Enrollment check — every student_id in the batch must actually
      // be enrolled in class_id for this term (see the single-entry route
      // for why this can't be inferred from the teacher-assignment check).
      const enrolledStudents = await getEnrolledStudentIds(req.params.schoolId, class_id, term_id, uniqueStudentIds);

      // (d) Load result_status for all students in batch
      const statusRows = await pool.query<{ student_id: string; status: string }>(
        `SELECT student_id, status FROM result_status
         WHERE student_id = ANY($1::uuid[]) AND term_id = $2 AND school_id = $3`,
        [uniqueStudentIds, term_id, req.params.schoolId]
      );
      const lockedStudents = new Set<string>(
        statusRows.rows
          .filter(r => ['submitted', 'approved', 'published'].includes(r.status))
          .map(r => r.student_id)
      );

      const result = await bulkUpsertScores(
        req.params.schoolId,
        subject_id,
        term_id,
        teacherId,
        entries,
        componentMap,
        lockedStudents,
        enrolledStudents
      );

      if (result.errors.length > 0) {
        return res.status(422).json({
          success: false,
          error: { code: 'BULK_VALIDATION_FAILED', message: 'One or more entries failed validation', details: result.errors },
        });
      }

      return res.status(201).json({ success: true, data: { saved: result.saved.length, scores: result.saved } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/scores/my-pending ──────────────────────────────────────────

router.get(
  '/:schoolId/scores/my-pending',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Default to authenticated user; admin/principal can query another teacher
      let teacherId = req.user!.user_id;
      if (req.query.teacher_id) {
        const requestedId = String(req.query.teacher_id);
        const isPrivileged = ['super_admin', 'principal'].includes(req.user!.role ?? '');
        if (requestedId !== teacherId && !isPrivileged) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'You can only view your own pending assignments' },
          });
        }
        teacherId = requestedId;
      }

      const term = await getActiveTerm(req.params.schoolId);
      if (!term) {
        return res.json({ success: true, data: [], meta: { message: 'No active term for this school' } });
      }

      const pending = await getMyPendingAssignments(teacherId, req.params.schoolId, term.id);
      return res.json({ success: true, data: pending, meta: { term_id: term.id, term_name: term.name } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
