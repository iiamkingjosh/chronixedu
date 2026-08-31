import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { hashSync } from 'bcryptjs';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
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
  findUsersRolesByEmails,
} from '../db/queries/students';
import { findClassById } from '../db/queries/roster';
import { logAudit } from '../db/queries/auditLog';
import { generateTranscript } from '../services/transcriptService';
import { signReportCardAsset } from '../services/reportCardService';
import { sendEmail } from '../services/emailService';
import { parseBulkImportFile, BulkImportParseError } from '../services/bulkImportParser';
import { runFullValidation } from '../services/bulkImportValidation';
import { generateBulkImportResultsFile, type CreatedStudentRecord, type CreatedParentRecord } from '../services/bulkImportResults';
import pool from '../db/client';
import { logger } from '../config/logger';
import { getSchoolName, welcomeEmailBody } from '../services/welcomeEmail';

async function checkParentStudentLink(parentId: string, studentId: string, schoolId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM parent_students ps
     JOIN students s ON s.id = ps.student_id
     WHERE ps.parent_id = $1 AND ps.student_id = $2 AND s.school_id = $3
     LIMIT 1`,
    [parentId, studentId, schoolId]
  );
  return result.rows.length > 0;
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
              welcomeEmailBody({ role: 'parent', name, email: p.email, tempPassword: p.temp_password, schoolName, appUrl, extraLine: 'Your Parent Portal gives you access to attendance, results, fees, and more.' })
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

// ── POST /:schoolId/students/bulk-import/preview ────────────────────────────────
// Parses and validates a spreadsheet without writing anything — the registrar
// confirms via /bulk-import/commit afterward. See docs/superpowers/specs/
// 2026-08-19-student-bulk-import-design.md for the full design rationale.

// Lowered from 200 to 50: measured ~2.7s/row end-to-end for the commit route means a
// full 200-row commit would be an unacceptably long ~9-minute synchronous HTTP request.
// At 50 rows a full batch stays under ~2.5 minutes, with margin (real production latency
// is likely better than the remote test DB this was measured against).
const MAX_BULK_IMPORT_ROWS = 50;
const bulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post(
  '/:schoolId/students/bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  bulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      // Verify actual file content via magic bytes before trusting the client-supplied
      // filename extension — mirrors the H-04 check on the photo upload route above.
      // Skipped for .csv: plain text has no reliable magic-byte signature.
      const isXlsxByName = file.originalname.toLowerCase().endsWith('.xlsx');
      if (isXlsxByName) {
        const detected = await fileTypeFromBuffer(file.buffer);
        const allowedXlsxMimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'];
        if (!detected || !allowedXlsxMimes.includes(detected.mime)) {
          return res.status(400).json({
            success: false,
            error: { code: 'PARSE_ERROR', message: 'This file could not be read as an Excel spreadsheet.' },
          });
        }
      }

      let parsedRows;
      try {
        parsedRows = await parseBulkImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof BulkImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        // A failure to parse the uploaded file is fundamentally a bad-input problem,
        // never a legitimate 500 — never re-throw here.
        return res.status(400).json({
          success: false,
          error: { code: 'PARSE_ERROR', message: 'This file could not be read. Please check it is a valid .xlsx or .csv file.' },
        });
      }

      if (parsedRows.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No student rows were found in this file.' } });
      }
      if (parsedRows.length > MAX_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${parsedRows.length} rows — the maximum per import is ${MAX_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const results = await runFullValidation(parsedRows, findUsersRolesByEmails);
      const summary = {
        total: results.length,
        valid: results.filter(r => r.status === 'valid').length,
        invalid: results.filter(r => r.status === 'error').length,
      };

      return res.json({ success: true, data: { rows: results, summary } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/students/bulk-import/commit ─────────────────────────────────
// Re-validates every row from scratch — never trusts the client-supplied
// "valid"/"error" status from preview. One registerStudent() transaction per
// row, so a single bad row can't roll back the rest of the batch.

const BULK_IMPORT_PASSWORD = 'Password2$';
const BULK_IMPORT_EMAIL_BATCH_SIZE = 50;

const bulkImportParentSchema = z.object({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  relationship_type: z.string().nullable(),
  is_primary_contact: z.boolean(),
});

const bulkImportCommitSchema = z.object({
  rows: z.array(z.object({
    row_number: z.number(),
    status: z.enum(['valid', 'error']),
    errors: z.array(z.string()),
    student: z.object({
      row_number: z.number(),
      first_name: z.string(),
      last_name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      dob: z.string().nullable(),
      gender: z.string().nullable(),
      address: z.string().nullable(),
      blood_group: z.string().nullable(),
      emergency_contact_name: z.string().nullable(),
      emergency_contact_phone: z.string().nullable(),
      parent1: bulkImportParentSchema.nullable(),
      parent2: bulkImportParentSchema.nullable(),
    }),
  })).min(1).max(MAX_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/students/bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = bulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const submittedRows = parsed.data.rows.map(r => r.student);
      const revalidated = await runFullValidation(submittedRows, findUsersRolesByEmails);

      const passwordHash = hashSync(BULK_IMPORT_PASSWORD, 12);
      const results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string; admission_no?: string }> = [];
      const createdStudents: CreatedStudentRecord[] = [];
      const allNewParents: CreatedParentRecord[] = [];

      for (const row of revalidated) {
        if (row.status === 'error') {
          results.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }

        const student = row.student;
        const parentsInput = [student.parent1, student.parent2]
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map(p => ({
            email: p.email!,
            first_name: p.first_name ?? '',
            last_name: p.last_name ?? '',
            phone: p.phone ?? undefined,
            relationship_type: p.relationship_type ?? '',
            is_primary_contact: p.is_primary_contact,
            passwordHash,
            tempPassword: BULK_IMPORT_PASSWORD,
          }));

        try {
          const result = await registerStudent(
            req.params.schoolId,
            {
              first_name: student.first_name,
              last_name: student.last_name,
              email: student.email ?? undefined,
              phone: student.phone ?? undefined,
              dob: student.dob,
              gender: student.gender,
              address: student.address,
              blood_group: student.blood_group,
              emergency_contact_name: student.emergency_contact_name,
              emergency_contact_phone: student.emergency_contact_phone,
              passwordHash,
            },
            parentsInput
          );

          results.push({ row_number: row.row_number, status: 'created', admission_no: result.admission_no });
          createdStudents.push({
            row_number: row.row_number,
            first_name: student.first_name,
            last_name: student.last_name,
            admission_no: result.admission_no,
            email: result.student.email,
          });
          for (const p of result.new_parents) {
            const source = parentsInput.find(pi => pi.email === p.email);
            allNewParents.push({
              first_name: source?.first_name ?? '',
              last_name: source?.last_name ?? '',
              email: p.email,
            });
          }
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'An account with this email already exists.'
            : 'Failed to create this record.';
          results.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }

      if (allNewParents.length > 0) {
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        getSchoolName(req.params.schoolId).then(async schoolName => {
          for (let i = 0; i < allNewParents.length; i += BULK_IMPORT_EMAIL_BATCH_SIZE) {
            const batch = allNewParents.slice(i, i + BULK_IMPORT_EMAIL_BATCH_SIZE);
            await Promise.all(
              batch.map(p => sendEmail(
                p.email,
                'Welcome to Chronix Edu — Your Parent Portal Access',
                welcomeEmailBody({ role: 'parent', name: `${p.first_name} ${p.last_name}`, email: p.email, tempPassword: BULK_IMPORT_PASSWORD, schoolName, appUrl, extraLine: 'Your Parent Portal gives you access to attendance, results, fees, and more.' })
              ).catch(() => {}))
            );
            if (i + BULK_IMPORT_EMAIL_BATCH_SIZE < allNewParents.length) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }).catch(() => {});
      }

      // Never let a results-file failure turn an already-successful commit into
      // an apparent 500 — every payment/record has already been written by this
      // point, so a bursar/registrar seeing an error here would reasonably
      // re-upload the file, risking duplicate records. Degrade gracefully.
      let resultsFile: Buffer | null = null;
      try {
        resultsFile = await generateBulkImportResultsFile(createdStudents, allNewParents);
      } catch (err) {
        logger.error('students_bulk_import_results_file_failed', { schoolId: req.params.schoolId, err });
      }

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'STUDENTS_BULK_IMPORT',
        entity: 'students',
        entityId: req.params.schoolId,
        newValue: { created: createdStudents.length, failed: results.filter(r => r.status === 'failed').length },
      });

      return res.json({
        success: true,
        data: {
          created: createdStudents.length,
          failed: results.filter(r => r.status === 'failed').length,
          results,
          download_base64: resultsFile ? resultsFile.toString('base64') : null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/students ────────────────────────────────────────────────────

router.get(
  '/:schoolId/students',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar', 'teacher'),
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
  requireRole('super_admin', 'principal', 'registrar', 'teacher', 'parent', 'student'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, studentId } = req.params;
      const role = req.user!.role;

      // Parents may only view students linked to them within this school.
      if (role === 'parent') {
        const linked = await checkParentStudentLink(req.user!.user_id, studentId, schoolId);
        if (!linked) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } });
        }
      }

      // Students may only view their own record.
      if (role === 'student') {
        const own = await pool.query(
          `SELECT id FROM students WHERE user_id = $1 AND id = $2 AND school_id = $3`,
          [req.user!.user_id, studentId, schoolId]
        );
        if (!own.rows[0]) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } });
        }
      }

      const profile = await getStudentProfile(studentId, schoolId);
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

      // H-04: verify actual file content via magic bytes, not the client-supplied Content-Type.
      const detected = await fileTypeFromBuffer(file.buffer);
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!detected || !allowedMimes.includes(detected.mime)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'File must be JPEG, PNG, or WebP.' } });
      }

      const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const ext = extMap[detected.mime];
      const storagePath = `schools/${req.params.schoolId}/students/${req.params.studentId}/photo.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: detected.mime, upsert: true });

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
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar', 'parent'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, studentId } = req.params;

      // Parents may only access report cards for their own linked children.
      if (req.user!.role === 'parent') {
        const linked = await checkParentStudentLink(req.user!.user_id, studentId, schoolId);
        if (!linked) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } });
        }
      }

      const termId = req.query.term_id as string | undefined;
      if (!termId || !/^[0-9a-f-]{36}$/.test(termId)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query param: term_id (UUID)' },
        });
      }

      // Staff (super_admin/principal/registrar) may review a report card before
      // it is released — that's the point of a staff review step. Parents may
      // only ever see a report card the school has explicitly published; this
      // mirrors the gate in routes/parent.ts's report-card route.
      const isParent = req.user!.role === 'parent';
      const result = await pool.query<{
        pdf_url: string | null;
        generated_at: string;
        is_published: boolean;
      }>(
        `SELECT pdf_url, generated_at, is_published
         FROM report_cards
         WHERE student_id = $1 AND term_id = $2 AND school_id = $3${isParent ? ' AND is_published = TRUE' : ''}`,
        [studentId, termId, schoolId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No report card found for this student and term.' },
        });
      }

      const row = result.rows[0];
      const pdfUrl = row.pdf_url ? await signReportCardAsset(row.pdf_url) : null;

      return res.json({ success: true, data: { ...row, pdf_url: pdfUrl } });
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

      // H-06: scope the lookup to this school to prevent cross-school parent linking.
      const existingUser = await pool.query<{ id: string; role: string }>(
        `SELECT id, role FROM users WHERE email = $1 AND school_id = $2`, [email, schoolId]
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
            welcomeEmailBody({ role: 'parent', name: `${first_name} ${last_name}`, email, tempPassword: pw, schoolName, appUrl, extraLine: 'Your Parent Portal gives you access to attendance, results, fees, and more.' })
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

      const storagePath = await generateTranscript(studentId, schoolId);
      const pdfUrl = await signReportCardAsset(storagePath);
      if (!pdfUrl) {
        return res.status(500).json({ success: false, error: { code: 'SIGNING_FAILED', message: 'Failed to generate a download link for the transcript.' } });
      }

      return res.json({ success: true, data: { pdf_url: pdfUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
