import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { hashSync } from 'bcryptjs';
import * as Sentry from '@sentry/node';
import { verifyToken, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../supabaseClient';
import {
  registerStudent,
  listStudents,
  getStudentProfile,
  updateStudentBio,
  updateStudentPhotoUrl,
  findStudentById,
  findEnrollmentForSession,
  insertStudentClass,
  findEnrollmentForCurrentSession,
  updateEnrollmentClass,
} from '../db/queries/students';
import { findClassById } from '../db/queries/roster';
import { logAudit } from '../db/queries/auditLog';
import { generateTranscript } from '../services/transcriptService';
import { sendEmail } from '../services/emailService';
import pool from '../db/client';

async function getSchoolName(schoolId: string): Promise<string> {
  const r = await pool.query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolId]);
  return r.rows[0]?.name ?? 'your school';
}

function welcomeEmailBody(
  role: 'parent' | 'student',
  name: string,
  email: string,
  tempPassword: string,
  schoolName: string,
  appUrl: string
): string {
  const portalLabel = role === 'parent' ? 'Parent Portal' : 'Student Portal';
  return [
    `Hello ${name},`,
    '',
    `You have been registered on Chronix Edu as a ${role} for ${schoolName}.`,
    '',
    'Your login credentials:',
    `  Email:    ${email}`,
    `  Password: ${tempPassword}`,
    '',
    `Log in here: ${appUrl}/login`,
    '',
    'IMPORTANT: Please change your password immediately after your first login.',
    `Your ${portalLabel} gives you access to attendance, results, fees, and more.`,
    '',
    'If you did not expect this email, please contact your school administrator.',
    '',
    '— Chronix Edu',
  ].join('\n');
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Schemas ────────────────────────────────────────────────────────────────────

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const parentSchema = z.object({
  email:              z.string().email(),
  first_name:         z.string().min(1).max(100),
  last_name:          z.string().min(1).max(100),
  phone:              z.string().max(30).optional(),
  relationship_type:  z.string().min(1).max(50),
  is_primary_contact: z.boolean().optional().default(false),
});

const registerSchema = z.object({
  first_name:               z.string().min(1).max(100),
  last_name:                z.string().min(1).max(100),
  email:                    z.string().email().optional(),
  phone:                    z.string().max(30).optional(),
  dob:                      z.string().regex(datePattern).optional().nullable(),
  gender:                   z.string().max(50).optional().nullable(),
  address:                  z.string().max(500).optional().nullable(),
  blood_group:              z.string().max(20).optional().nullable(),
  emergency_contact_name:   z.string().max(200).optional().nullable(),
  emergency_contact_phone:  z.string().max(30).optional().nullable(),
  class_id:                 z.string().uuid().optional().nullable(),
  parents:                  z.array(parentSchema).optional().default([]),
});

const patchSchema = z.object({
  first_name:               z.string().min(1).max(100).optional(),
  last_name:                z.string().min(1).max(100).optional(),
  phone:                    z.string().max(30).optional(),
  dob:                      z.string().regex(datePattern).optional().nullable(),
  gender:                   z.string().max(50).optional().nullable(),
  address:                  z.string().max(500).optional().nullable(),
  blood_group:              z.string().max(20).optional().nullable(),
  emergency_contact_name:   z.string().max(200).optional().nullable(),
  emergency_contact_phone:  z.string().max(30).optional().nullable(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const promoteSchema = z.object({
  class_id:   z.string().uuid(),
  session_id: z.string().uuid(),
});

const classCorrectionSchema = z.object({
  class_id: z.string().uuid(),
  reason:   z.string().min(10, 'Reason must be at least 10 characters').max(500),
});

const promoteBulkSchema = z.object({
  from_session_id: z.string().uuid(),
  to_session_id:   z.string().uuid(),
  decisions: z.array(z.object({
    student_id: z.string().uuid(),
    class_id:   z.string().uuid(),
    decision:   z.enum(['promoted', 'repeat']),
  })).min(1),
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

// ── POST /:schoolId/students ───────────────────────────────────────────────────

router.post(
  '/:schoolId/students',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { parents, ...studentData } = parsed.data;

      // Generate student password upfront — plaintext returned to admin, hash stored
      const tempPassword = randomBytes(8).toString('hex');
      const passwordHash = hashSync(tempPassword, 12);

      // Pre-hash parent passwords so the transaction doesn't do heavy crypto inside DB round-trips
      const parentsWithHashes = parents.map(p => {
        const tp = randomBytes(8).toString('hex');
        return { ...p, passwordHash: hashSync(tp, 12), tempPassword: tp };
      });

      const result = await registerStudent(
        req.params.schoolId,
        { ...studentData, passwordHash },
        parentsWithHashes
      );

      // Send welcome emails to newly created parent accounts (fire-and-forget)
      if (result.new_parents.length > 0) {
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        getSchoolName(req.params.schoolId).then(schoolName => {
          for (const p of result.new_parents) {
            const parent = parentsWithHashes.find(ph => ph.email === p.email);
            const name = parent ? `${parent.first_name} ${parent.last_name}` : p.email;
            sendEmail(
              p.email,
              `Welcome to Chronix Edu — Your Parent Portal Access`,
              welcomeEmailBody('parent', name, p.email, p.temp_password, schoolName, appUrl)
            ).catch(() => {});
          }
        }).catch(() => {});
      }

      Sentry.getCurrentScope().addEventProcessor(event => {
        if (event.request?.url?.includes('/students') || event.request?.url?.includes('/parents')) {
          if (event.request.data) event.request.data = '[Filtered — contains credentials]';
        }
        return event;
      });

      return res.status(201).json({
        success: true,
        data: {
          student:      result.student,
          admission_no: result.admission_no,
          temp_password: tempPassword,
          enrollment:   result.enrollment,
          new_parents:  result.new_parents,
        },
      });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505') {
        // Unique violation — most likely duplicate email
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'An account with this email already exists' } });
      }
      return next(err);
    }
  }
);

// ── GET /:schoolId/students ────────────────────────────────────────────────────

router.get(
  '/:schoolId/students',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'),  10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

      const result = await listStudents(req.params.schoolId, {
        page,
        limit,
        classId:   req.query.class_id   ? String(req.query.class_id)   : undefined,
        sessionId: req.query.session_id ? String(req.query.session_id) : undefined,
        search:    req.query.search     ? String(req.query.search)     : undefined,
      });

      return res.json({
        success: true,
        data: result.students,
        meta: {
          total: result.total,
          page:  result.page,
          limit: result.limit,
          pages: Math.ceil(result.total / result.limit),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/students/:studentId ─────────────────────────────────────────

router.get(
  '/:schoolId/students/:studentId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await getStudentProfile(req.params.studentId, req.params.schoolId);
      if (!profile) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }
      return res.json({ success: true, data: profile });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/students/:studentId ──────────────────────────────────────

router.patch(
  '/:schoolId/students/:studentId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const student = await findStudentById(req.params.studentId, req.params.schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      await updateStudentBio(req.params.studentId, req.params.schoolId, parsed.data);
      return res.json({ success: true, data: { message: 'Student updated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/students/:studentId/photo ─────────────────────────────────

router.post(
  '/:schoolId/students/:studentId/photo',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  upload.single('photo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const student = await findStudentById(req.params.studentId, req.params.schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "photo".' } });
      }

      const allowed = ['image/jpeg', 'image/png'];
      if (!allowed.includes(file.mimetype)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'Only JPEG and PNG files are allowed.' } });
      }

      const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
      const storagePath = `schools/${req.params.schoolId}/students/${req.params.studentId}/photo.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      await updateStudentPhotoUrl(req.params.studentId, req.params.schoolId, urlData.publicUrl);

      return res.json({ success: true, data: { photo_url: urlData.publicUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/students/:studentId/promote ───────────────────────────────

router.post(
  '/:schoolId/students/:studentId/promote',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = promoteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { class_id, session_id } = parsed.data;

      const student = await findStudentById(req.params.studentId, req.params.schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      // Verify session and class both belong to this school
      const [sessionCheck, classCheck] = await Promise.all([
        pool.query(`SELECT id FROM academic_sessions WHERE id = $1 AND school_id = $2`, [session_id, req.params.schoolId]),
        pool.query(`SELECT id FROM classes WHERE id = $1 AND school_id = $2`, [class_id, req.params.schoolId]),
      ]);

      if (!sessionCheck.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found in this school' } });
      }
      if (!classCheck.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found in this school' } });
      }

      // Prevent duplicate enrollment for the same session
      const alreadyEnrolled = await findEnrollmentForSession(req.params.studentId, session_id);
      if (alreadyEnrolled) {
        return res.status(409).json({
          success: false,
          error: { code: 'ALREADY_ENROLLED', message: 'Student is already enrolled in a class for this session. Prior enrolment records are preserved.' },
        });
      }

      const enrollment = await insertStudentClass(req.params.studentId, class_id, session_id);
      return res.status(201).json({ success: true, data: enrollment });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/students/:studentId/report-card ────────────────────────────

router.get(
  '/:schoolId/students/:studentId/report-card',
  verifyToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const termId = req.query.term_id as string | undefined;
      if (!termId || !/^[0-9a-f-]{36}$/.test(termId)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      const { schoolId, studentId } = req.params;

      const result = await pool.query<{
        pdf_url: string | null;
        generated_at: string;
        is_published: boolean;
      }>(
        `SELECT pdf_url, generated_at, is_published
         FROM report_cards
         WHERE student_id = $1 AND term_id = $2 AND school_id = $3`,
        [studentId, termId, schoolId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No report card found for this student and term.' },
        });
      }

      return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/students/:studentId/class ────────────────────────────────
// Intra-session class correction — requires a reason and writes an audit log entry.

router.patch(
  '/:schoolId/students/:studentId/class',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = classCorrectionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId, studentId } = req.params;
      const { class_id, reason } = parsed.data;

      const student = await findStudentById(studentId, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const newClass = await findClassById(class_id, schoolId);
      if (!newClass) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Class not found in this school' } });
      }

      const enrollment = await findEnrollmentForCurrentSession(studentId, schoolId);
      if (!enrollment) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student has no enrollment for the current session' } });
      }

      if (enrollment.class_id === class_id) {
        return res.status(400).json({ success: false, error: { code: 'NO_CHANGE', message: 'Student is already in this class' } });
      }

      await updateEnrollmentClass(enrollment.id, class_id);

      await logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId:     req.user!.user_id,
        actionType: 'STUDENT_CLASS_CORRECTED',
        entity:     'student_classes',
        entityId:   enrollment.id,
        oldValue:   { class_id: enrollment.class_id },
        newValue:   { class_id, reason },
      });

      return res.json({ success: true, data: { message: 'Class updated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/students/promote-bulk ─────────────────────────────────────
// End-of-session promotion: enrolls each student into the target session, either
// into a new class (promoted) or the same class carried over (repeat).

router.post(
  '/:schoolId/students/promote-bulk',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = promoteBulkSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const { from_session_id, to_session_id, decisions } = parsed.data;

      const sessionCheck = await pool.query(
        `SELECT id FROM academic_sessions WHERE id = $1 AND school_id = $2`,
        [to_session_id, schoolId]
      );
      if (!sessionCheck.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Target session not found in this school' } });
      }

      const classIds = [...new Set(decisions.map(d => d.class_id))];
      const classCheck = await pool.query<{ id: string }>(
        `SELECT id FROM classes WHERE school_id = $1 AND id = ANY($2::uuid[])`,
        [schoolId, classIds]
      );
      if (classCheck.rows.length !== classIds.length) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'One or more target classes were not found in this school' } });
      }

      const results: Array<{ student_id: string; status: 'enrolled' | 'skipped'; reason?: string }> = [];

      for (const decision of decisions) {
        const student = await findStudentById(decision.student_id, schoolId);
        if (!student) {
          results.push({ student_id: decision.student_id, status: 'skipped', reason: 'Student not found' });
          continue;
        }

        const alreadyEnrolled = await findEnrollmentForSession(decision.student_id, to_session_id);
        if (alreadyEnrolled) {
          results.push({ student_id: decision.student_id, status: 'skipped', reason: 'Already enrolled for target session' });
          continue;
        }

        await insertStudentClass(decision.student_id, decision.class_id, to_session_id);
        results.push({ student_id: decision.student_id, status: 'enrolled' });
      }

      await logAudit({
        supportSession: req.supportSession,
        schoolId,
        userId:     req.user!.user_id,
        actionType: 'BULK_PROMOTION',
        entity:     'student_classes',
        oldValue:   { from_session_id },
        newValue:   { to_session_id, decisions, results },
      }).catch(() => {});

      return res.status(201).json({ success: true, data: { results } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/students/:studentId/parents ───────────────────────────────

const addParentSchema = z.object({
  email:              z.string().email(),
  first_name:         z.string().min(1).max(100),
  last_name:          z.string().min(1).max(100),
  phone:              z.string().max(30).optional(),
  relationship_type:  z.string().min(1).max(50),
  is_primary_contact: z.boolean().optional().default(false),
});

router.post(
  '/:schoolId/students/:studentId/parents',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = addParentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId, studentId } = req.params;
      const { email, first_name, last_name, phone, relationship_type, is_primary_contact } = parsed.data;

      const student = await findStudentById(studentId, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const existingUser = await pool.query<{ id: string; role: string }>(
        `SELECT id, role FROM users WHERE email = $1`, [email]
      );

      let parentUserId: string;
      let tempPassword: string | null = null;
      let isNewAccount = false;

      if (existingUser.rows.length > 0) {
        const existing = existingUser.rows[0];
        if (existing.role !== 'parent') {
          return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'A non-parent account already exists with this email' } });
        }
        parentUserId = existing.id;
      } else {
        isNewAccount = true;
        const rawPassword = randomBytes(8).toString('hex');
        tempPassword = rawPassword;
        const passwordHash = hashSync(rawPassword, 12);

        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: rawPassword,
          email_confirm: true,
        });

        if (authError || !authUser.user) {
          return res.status(500).json({ success: false, error: { code: 'AUTH_ERROR', message: authError?.message ?? 'Failed to create auth user' } });
        }

        parentUserId = authUser.user.id;

        await pool.query(
          `INSERT INTO users (id, school_id, email, first_name, last_name, phone, role, password_hash)
           VALUES ($1, $2, $3, $4, $5, $6, 'parent', $7)`,
          [parentUserId, schoolId, email, first_name, last_name, phone ?? null, passwordHash]
        );
      }

      const alreadyLinked = await pool.query(
        `SELECT id FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
        [parentUserId, studentId]
      );
      if (alreadyLinked.rows.length > 0) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_LINKED', message: 'This parent is already linked to this student' } });
      }

      await pool.query(
        `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
         VALUES ($1, $2, $3, $4)`,
        [parentUserId, studentId, relationship_type, is_primary_contact ?? false]
      );

      // Send welcome email to newly created parent accounts (fire-and-forget)
      if (isNewAccount && tempPassword !== null) {
        const pw = tempPassword;
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        getSchoolName(schoolId).then(schoolName => {
          sendEmail(
            email,
            `Welcome to Chronix Edu — Your Parent Portal Access`,
            welcomeEmailBody('parent', `${first_name} ${last_name}`, email, pw, schoolName, appUrl)
          ).catch(() => {});
        }).catch(() => {});
      }

      Sentry.getCurrentScope().addEventProcessor(event => {
        if (event.request?.url?.includes('/students') || event.request?.url?.includes('/parents')) {
          if (event.request.data) event.request.data = '[Filtered — contains credentials]';
        }
        return event;
      });

      return res.status(201).json({
        success: true,
        data: {
          parent_id: parentUserId,
          email,
          first_name,
          last_name,
          is_new_account: isNewAccount,
          temp_password: tempPassword,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/students/:studentId/transcript ────────────────────────────

router.post(
  '/:schoolId/students/:studentId/transcript',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, studentId } = req.params;

      const student = await findStudentById(studentId, schoolId);
      if (!student) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Student not found' } });
      }

      const pdfUrl = await generateTranscript(studentId, schoolId);
      return res.json({ success: true, data: { pdf_url: pdfUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
