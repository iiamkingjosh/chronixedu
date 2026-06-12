import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { findStudentByUserId, getStudentProfile, StudentRow } from '../db/queries/students';
import { getResultStatus } from '../db/queries/scores';
import { getStudentAttendanceHistory } from '../db/queries/attendance';
import { getNoticesForClass } from '../db/queries/notices';
import { getCurrentContext } from '../db/queries/sessions';
import { computeClassResults, getStudentClassId } from '../services/resultEngine';
import pool from '../db/client';

declare module 'express-serve-static-core' {
  interface Request {
    student?: StudentRow;
  }
}

const router = Router();

// ── Middleware ─────────────────────────────────────────────────────────────────

function requireSchoolAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

/** Resolves the caller's own student record — students can never query another student's data. */
async function requireStudentRecord(req: Request, res: Response, next: NextFunction): Promise<void> {
  const student = await findStudentByUserId(req.user!.user_id, req.params.schoolId);
  if (!student) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No student record found for this account' } });
    return;
  }
  req.student = student;
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
    class_id:     currentEnrollment?.class_id ?? null,
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

// ── GET /:schoolId/student/dashboard ───────────────────────────────────────────

router.get(
  '/:schoolId/student/dashboard',
  verifyToken,
  requireSchoolAccess,
  requireRole('student'),
  requireStudentRecord,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const studentId = req.student!.id;

      let termId = req.query.term_id ? String(req.query.term_id) : undefined;
      let termName: string | null = null;

      if (!termId) {
        const { term } = await getCurrentContext(schoolId);
        if (!term) {
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No active term has been set up yet' } });
        }
        termId = term.id;
        termName = term.name;
      }

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
      let subjects: Array<{ subject_id: string; subject_name: string; total_score: number | null; grade: string | null }> = [];

      if (classId) {
        const classResult = await computeClassResults(classId, termId, schoolId);
        if (!termName) termName = classResult.term_name;
        const studentRecord = classResult.students.find(s => s.student_id === studentId);
        if (studentRecord) {
          academic = {
            overall_average: studentRecord.overall_average,
            position: studentRecord.position,
            total_students: classResult.total_students,
            subjects_scored: studentRecord.subjects_scored,
            total_subjects: studentRecord.subjects.length,
          };
          subjects = studentRecord.subjects.map(sub => ({
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
          term: { id: termId, name: termName },
          academic,
          subjects,
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

// ── GET /:schoolId/student/results ─────────────────────────────────────────────

router.get(
  '/:schoolId/student/results',
  verifyToken,
  requireSchoolAccess,
  requireRole('student'),
  requireStudentRecord,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId } = req.params;
      const { term_id: termId } = parsed.data;
      const studentId = req.student!.id;

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

// ── GET /:schoolId/student/report-card ─────────────────────────────────────────

router.get(
  '/:schoolId/student/report-card',
  verifyToken,
  requireSchoolAccess,
  requireRole('student'),
  requireStudentRecord,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = termQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId } = req.params;
      const { term_id: termId } = parsed.data;
      const studentId = req.student!.id;

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

// ── GET /:schoolId/student/notices ─────────────────────────────────────────────

router.get(
  '/:schoolId/student/notices',
  verifyToken,
  requireSchoolAccess,
  requireRole('student'),
  requireStudentRecord,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const studentId = req.student!.id;

      const profile = await getStudentProfile(studentId, schoolId);
      if (!profile) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const classId = profile.enrollments[0]?.class_id ?? null;
      const notices = await getNoticesForClass(schoolId, classId);
      return res.json({ success: true, data: notices });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
