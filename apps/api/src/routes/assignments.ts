import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { verifyToken, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../supabaseClient';
import { getActiveTerm } from '../db/queries/roster';
import { findStudentByUserId, getStudentProfile } from '../db/queries/students';
import {
  createAssignment,
  updateAssignmentAttachment,
  findAssignmentById,
  listAssignmentsForTeacher,
  listAssignmentsForSchool,
  listAssignmentsForStudent,
  listSubmissionsForAssignment,
  upsertSubmission,
  gradeSubmission,
} from '../db/queries/assignments';
import pool from '../db/client';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ALLOWED_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

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

// ── Schemas ────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  class_id: z.string().uuid(),
  subject_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  due_date: z.string().refine(v => !isNaN(Date.parse(v)), { message: 'due_date must be a valid date' }),
});

const gradeSchema = z.object({
  grade: z.number().min(0).max(1000).nullable().optional(),
  feedback: z.string().max(2000).nullable().optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function bucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';
}

async function uploadFile(storagePath: string, file: Express.Multer.File): Promise<string | null> {
  const { error } = await supabaseAdmin.storage
    .from(bucketName())
    .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });
  if (error) return null;
  const { data } = supabaseAdmin.storage.from(bucketName()).getPublicUrl(storagePath);
  return data.publicUrl;
}

// ── POST /:schoolId/assignments ────────────────────────────────────────────────

router.post(
  '/:schoolId/assignments',
  verifyToken,
  requireSchoolAccess,
  requireRole('teacher'),
  upload.single('attachment'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const teacherId = req.user!.user_id;
      const { class_id, subject_id, title, description, due_date } = parsed.data;

      const file = req.file;
      let ext: string | null = null;
      if (file) {
        ext = ALLOWED_FILE_TYPES[file.mimetype] ?? null;
        if (!ext) {
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_FILE_TYPE', message: 'Allowed attachment types: PDF, DOC, DOCX, JPG, PNG.' },
          });
        }
      }

      const term = await getActiveTerm(schoolId);
      if (!term) {
        return res.status(404).json({ success: false, error: { code: 'NO_ACTIVE_TERM', message: 'No active term found for this school.' } });
      }

      const assigned = await pool.query(
        `SELECT id FROM teacher_assignments WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3 AND school_id = $4 AND term_id = $5 LIMIT 1`,
        [teacherId, class_id, subject_id, schoolId, term.id]
      );
      if (assigned.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this class and subject for the active term.' },
        });
      }

      let assignment = await createAssignment({
        school_id: schoolId,
        class_id,
        subject_id,
        teacher_id: teacherId,
        title,
        description: description ?? null,
        due_date,
      });

      if (file && ext) {
        const storagePath = `schools/${schoolId}/assignments/${assignment.id}/attachment.${ext}`;
        const publicUrl = await uploadFile(storagePath, file);
        if (!publicUrl) {
          return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: 'Failed to upload attachment.' } });
        }
        assignment = (await updateAssignmentAttachment(assignment.id, schoolId, publicUrl)) ?? assignment;
      }

      return res.status(201).json({ success: true, data: assignment });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/assignments ─────────────────────────────────────────────────

router.get(
  '/:schoolId/assignments',
  verifyToken,
  requireSchoolAccess,
  requireRole('teacher', 'student', 'super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;

      if (req.user!.role === 'teacher') {
        const data = await listAssignmentsForTeacher(req.user!.user_id, schoolId);
        return res.json({ success: true, data });
      }

      if (req.user!.role === 'super_admin' || req.user!.role === 'principal') {
        const data = await listAssignmentsForSchool(schoolId);
        return res.json({ success: true, data });
      }

      const student = await findStudentByUserId(req.user!.user_id, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No student record found for this account' } });
      }

      const profile = await getStudentProfile(student.id, schoolId);
      const classId = profile?.enrollments[0]?.class_id ?? null;
      if (!classId) {
        return res.json({ success: true, data: [] });
      }

      const data = await listAssignmentsForStudent(schoolId, classId, student.id);
      return res.json({ success: true, data });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/assignments/:assignmentId/submissions ───────────────────────

router.get(
  '/:schoolId/assignments/:assignmentId/submissions',
  verifyToken,
  requireSchoolAccess,
  requireRole('teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, assignmentId } = req.params;

      const assignment = await findAssignmentById(assignmentId, schoolId);
      if (!assignment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
      }
      if (assignment.teacher_id !== req.user!.user_id) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const submissions = await listSubmissionsForAssignment(assignment.id, assignment.class_id);
      return res.json({ success: true, data: { assignment, submissions } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/assignments/:assignmentId/submissions ──────────────────────

router.post(
  '/:schoolId/assignments/:assignmentId/submissions',
  verifyToken,
  requireSchoolAccess,
  requireRole('student'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, assignmentId } = req.params;

      const student = await findStudentByUserId(req.user!.user_id, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No student record found for this account' } });
      }

      const assignment = await findAssignmentById(assignmentId, schoolId);
      if (!assignment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
      }

      const profile = await getStudentProfile(student.id, schoolId);
      const classId = profile?.enrollments[0]?.class_id ?? null;
      if (assignment.class_id !== classId) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      if (Date.now() > new Date(assignment.due_date).getTime()) {
        return res.status(400).json({
          success: false,
          error: { code: 'PAST_DUE', message: 'The due date for this assignment has passed. Submissions are no longer accepted.' },
        });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      const ext = ALLOWED_FILE_TYPES[file.mimetype];
      if (!ext) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: 'Allowed file types: PDF, DOC, DOCX, JPG, PNG.' },
        });
      }

      const storagePath = `schools/${schoolId}/assignments/${assignmentId}/submissions/${student.id}.${ext}`;
      const publicUrl = await uploadFile(storagePath, file);
      if (!publicUrl) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: 'Failed to upload submission.' } });
      }

      const submission = await upsertSubmission(assignmentId, student.id, publicUrl);
      return res.json({ success: true, data: submission });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/assignments/:assignmentId/submissions/:studentId ──────────

router.patch(
  '/:schoolId/assignments/:assignmentId/submissions/:studentId',
  verifyToken,
  requireSchoolAccess,
  requireRole('teacher'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = gradeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId, assignmentId, studentId } = req.params;

      const assignment = await findAssignmentById(assignmentId, schoolId);
      if (!assignment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
      }
      if (assignment.teacher_id !== req.user!.user_id) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const updated = await gradeSubmission(
        assignmentId,
        studentId,
        parsed.data.grade ?? null,
        parsed.data.feedback ?? null,
        req.user!.user_id
      );
      if (!updated) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'This student has not submitted the assignment yet.' } });
      }

      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
