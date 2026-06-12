import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { getLinkedChildren, isParentLinkedToStudent } from '../db/queries/parents';
import { getStudentProfile } from '../db/queries/students';
import { getResultStatus } from '../db/queries/scores';
import { getStudentAttendanceHistory } from '../db/queries/attendance';
import { computeClassResults, getStudentClassId } from '../services/resultEngine';
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

async function requireLinkedChild(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.user!;
  if (user.role === 'super_admin') { next(); return; }

  const linked = await isParentLinkedToStudent(user.user_id, req.params.studentId);
  if (!linked) {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You are not linked to this student' } });
    return;
  }
  next();
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const termQuerySchema = z.object({
  term_id: z.string().uuid(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function summarizeStudent(profile: NonNullable<Awaited<ReturnType<typeof getStudentProfile>>>) {
  const currentEnrollment = profile.enrollments[0] ?? null;
  return {
    student_id:   profile.id,
    first_name:   profile.first_name,
    last_name:    profile.last_name,
    admission_no: profile.admission_no,
    photo_url:    profile.photo_url,
    class_name:   currentEnrollment?.class_name ?? null,
    class_level:  currentEnrollment?.class_level ?? null,
  };
}

async function findPublishedReportCard(studentId: string, termId: string, schoolId: string) {
  const result = await pool.query<{ pdf_url: string | null; generated_at: string; is_published: boolean }>(
    `SELECT pdf_url, generated_at, is_published
     FROM report_cards
     WHERE student_id = $1 AND term_id = $2 AND school_id = $3 AND is_published = TRUE`,
    [studentId, termId, schoolId]
  );
  return result.rows[0] ?? null;
}

// ── GET /:schoolId/parent/children ─────────────────────────────────────────────

router.get(
  '/:schoolId/parent/children',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const children = await getLinkedChildren(req.user!.user_id, req.params.schoolId);
      return res.json({ success: true, data: children });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/parent/students/:studentId/snapshot ─────────────────────────

router.get(
  '/:schoolId/parent/students/:studentId/snapshot',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'super_admin'),
  requireLinkedChild,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId, studentId } = req.params;
      const { term_id: termId } = parsed.data;

      const profile = await getStudentProfile(studentId, schoolId);
      if (!profile) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const [classId, attendance, resultStatus, reportCard] = await Promise.all([
        getStudentClassId(studentId, termId),
        getStudentAttendanceHistory(studentId, schoolId, termId),
        getResultStatus(studentId, termId, schoolId),
        findPublishedReportCard(studentId, termId, schoolId),
      ]);

      let academic = null;
      let recentResults: Array<{ subject_id: string; subject_name: string; total_score: number | null; grade: string | null }> = [];

      if (classId) {
        const classResult = await computeClassResults(classId, termId, schoolId);
        const studentRecord = classResult.students.find(s => s.student_id === studentId);
        if (studentRecord) {
          academic = {
            overall_average: studentRecord.overall_average,
            position: studentRecord.position,
            total_students: classResult.total_students,
            subjects_scored: studentRecord.subjects_scored,
            total_subjects: studentRecord.subjects.length,
          };
          recentResults = studentRecord.subjects.map(sub => ({
            subject_id: sub.subject_id,
            subject_name: sub.subject_name,
            total_score: sub.result?.total_score ?? null,
            grade: sub.result?.grade ?? null,
          }));
        }
      }

      return res.json({
        success: true,
        data: {
          student: summarizeStudent(profile),
          term_id: termId,
          academic,
          recent_results: recentResults,
          attendance: attendance.summary,
          result_status: resultStatus,
          report_card_available: reportCard !== null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/parent/students/:studentId/results ──────────────────────────

router.get(
  '/:schoolId/parent/students/:studentId/results',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'super_admin'),
  requireLinkedChild,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId, studentId } = req.params;
      const { term_id: termId } = parsed.data;

      const profile = await getStudentProfile(studentId, schoolId);
      if (!profile) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const [classId, resultStatus, reportCard] = await Promise.all([
        getStudentClassId(studentId, termId),
        getResultStatus(studentId, termId, schoolId),
        findPublishedReportCard(studentId, termId, schoolId),
      ]);

      let overall_average = 0;
      let position = 0;
      let total_students = 0;
      let subjects: Array<{
        subject_id: string;
        subject_name: string;
        subject_code: string;
        components: Array<{ component_id: string; name: string; max_score: number; weight_percent: number; score: number | null; contribution: number }>;
        total_score: number | null;
        grade: string | null;
        remark: string | null;
      }> = [];

      if (classId) {
        const classResult = await computeClassResults(classId, termId, schoolId);
        const studentRecord = classResult.students.find(s => s.student_id === studentId);
        if (studentRecord) {
          overall_average = studentRecord.overall_average;
          position = studentRecord.position;
          total_students = classResult.total_students;
          subjects = studentRecord.subjects.map(sub => ({
            subject_id: sub.subject_id,
            subject_name: sub.subject_name,
            subject_code: sub.subject_code,
            components: sub.result?.components ?? [],
            total_score: sub.result?.total_score ?? null,
            grade: sub.result?.grade ?? null,
            remark: sub.result?.remark ?? null,
          }));
        }
      }

      return res.json({
        success: true,
        data: {
          student: summarizeStudent(profile),
          term_id: termId,
          overall_average,
          position,
          total_students,
          subjects,
          result_status: resultStatus,
          report_card: {
            available: reportCard !== null,
            pdf_url: reportCard?.pdf_url ?? null,
          },
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/parent/students/:studentId/report-card ──────────────────────

router.get(
  '/:schoolId/parent/students/:studentId/report-card',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'super_admin'),
  requireLinkedChild,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId, studentId } = req.params;
      const { term_id: termId } = parsed.data;

      const reportCard = await findPublishedReportCard(studentId, termId, schoolId);
      if (!reportCard) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_PUBLISHED', message: 'No published report card is available for this term yet' },
        });
      }

      return res.json({ success: true, data: reportCard });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/parent/students/:studentId/attendance ───────────────────────

router.get(
  '/:schoolId/parent/students/:studentId/attendance',
  verifyToken,
  requireSchoolAccess,
  requireRole('parent', 'super_admin'),
  requireLinkedChild,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId, studentId } = req.params;
      const { term_id: termId } = parsed.data;

      const history = await getStudentAttendanceHistory(studentId, schoolId, termId);
      return res.json({ success: true, data: history });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
