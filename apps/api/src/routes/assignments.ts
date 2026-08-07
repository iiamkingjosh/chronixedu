import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
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
import type {
  AssignmentRow,
  StudentAssignmentListRow,
  SubmissionGridRow,
} from '../db/queries/assignments';
import pool from '../db/client';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

const ASSET_SIGNED_URL_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Extracts the bare storage path from either a bare path (returned as-is) or a legacy
 * Supabase public URL, for backward compatibility with any rows persisted before
 * assignment attachments/submissions were served via signed URLs.
 */
function extractAssetStoragePath(urlOrPath: string): string {
  const marker = `/storage/v1/object/public/${bucketName()}/`;
  const idx = urlOrPath.indexOf(marker);
  if (idx === -1) return urlOrPath;
  return decodeURIComponent(urlOrPath.slice(idx + marker.length));
}

/** Uploads a file and returns its storage path (not a URL) — the bucket holds private
 *  submissions/attachments, so a signed URL must be minted at read time instead. */
async function uploadFile(storagePath: string, file: Express.Multer.File, contentType: string): Promise<string | null> {
  const { error } = await supabaseAdmin.storage
    .from(bucketName())
    .upload(storagePath, file.buffer, { contentType, upsert: true });
  if (error) return null;
  return storagePath;
}

/** Mints a fresh, short-lived signed URL for an assignment attachment/submission object.
 *  Returns null when there is nothing to sign, or the object cannot be signed. */
async function signAssetUrl(storagePathOrUrl: string | null): Promise<string | null> {
  if (!storagePathOrUrl) return null;
  const storagePath = extractAssetStoragePath(storagePathOrUrl);
  const { data, error } = await supabaseAdmin.storage
    .from(bucketName())
    .createSignedUrl(storagePath, ASSET_SIGNED_URL_TTL_SECONDS);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Signs the attachment_url on any assignment-shaped row, leaving the rest untouched. */
async function withSignedAttachment<T extends { attachment_url: string | null }>(row: T): Promise<T> {
  return { ...row, attachment_url: await signAssetUrl(row.attachment_url) };
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
      let detectedMime: string | null = null;
      if (file) {
        const detected = await fileTypeFromBuffer(file.buffer);
        ext = detected ? (ALLOWED_FILE_TYPES[detected.mime] ?? null) : null;
        if (!detected || !ext) {
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_FILE_TYPE', message: 'Allowed attachment types: PDF, DOC, DOCX, JPG, PNG.' },
          });
        }
        detectedMime = detected.mime;
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

      if (file && ext && detectedMime) {
        const storagePath = `schools/${schoolId}/assignments/${assignment.id}/attachment.${ext}`;
        const uploadedPath = await uploadFile(storagePath, file, detectedMime);
        if (!uploadedPath) {
          return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: 'Failed to upload attachment.' } });
        }
        assignment = (await updateAssignmentAttachment(assignment.id, schoolId, uploadedPath)) ?? assignment;
      }

      const responseAssignment: AssignmentRow = await withSignedAttachment(assignment);
      return res.status(201).json({ success: true, data: responseAssignment });
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
        const signed = await Promise.all(data.map(withSignedAttachment));
        return res.json({ success: true, data: signed });
      }

      if (req.user!.role === 'super_admin' || req.user!.role === 'principal') {
        const data = await listAssignmentsForSchool(schoolId);
        const signed = await Promise.all(data.map(withSignedAttachment));
        return res.json({ success: true, data: signed });
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
      const signed: StudentAssignmentListRow[] = await Promise.all(
        data.map(async row => {
          const attachment_url = await signAssetUrl(row.attachment_url);
          if (!row.submission) return { ...row, attachment_url, submission: null };
          const file_url = (await signAssetUrl(row.submission.file_url)) ?? row.submission.file_url;
          return { ...row, attachment_url, submission: { ...row.submission, file_url } };
        })
      );
      return res.json({ success: true, data: signed });
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
      const signedSubmissions: SubmissionGridRow[] = await Promise.all(
        submissions.map(async row => {
          if (!row.submission) return row;
          const file_url = (await signAssetUrl(row.submission.file_url)) ?? row.submission.file_url;
          return { ...row, submission: { ...row.submission, file_url } };
        })
      );
      const signedAssignment: AssignmentRow = await withSignedAttachment(assignment);
      return res.json({ success: true, data: { assignment: signedAssignment, submissions: signedSubmissions } });
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

      const detectedSub = await fileTypeFromBuffer(file.buffer);
      const ext = detectedSub ? (ALLOWED_FILE_TYPES[detectedSub.mime] ?? null) : null;
      if (!detectedSub || !ext) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: 'Allowed file types: PDF, DOC, DOCX, JPG, PNG.' },
        });
      }

      const storagePath = `schools/${schoolId}/assignments/${assignmentId}/submissions/${student.id}.${ext}`;
      const uploadedPath = await uploadFile(storagePath, file, detectedSub.mime);
      if (!uploadedPath) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: 'Failed to upload submission.' } });
      }

      const submission = await upsertSubmission(assignmentId, student.id, uploadedPath);
      const file_url = (await signAssetUrl(submission.file_url)) ?? submission.file_url;
      return res.json({ success: true, data: { ...submission, file_url } });
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

      const file_url = (await signAssetUrl(updated.file_url)) ?? updated.file_url;
      return res.json({ success: true, data: { ...updated, file_url } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
