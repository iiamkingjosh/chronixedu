import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { verifyToken, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../supabaseClient';
import { redis } from '../middleware/rateLimit';
import { sendEmail } from '../services/emailService';
import { logAudit, logSettingsChange } from '../db/queries/auditLog';
import {
  listUsers,
  findUserById,
  findUserByEmail,
  insertUser,
  updateUserProfile,
  reassignUserEmail,
  setUserActive,
  updateUserSignature,
} from '../db/queries/users';
import { findUsersRolesByEmails } from '../db/queries/students';
import { parseStaffBulkImportFile, StaffBulkImportParseError } from '../services/staffBulkImportParser';
import { runFullStaffValidation, STAFF_ROLES } from '../services/staffBulkImportValidation';
import { generateStaffBulkImportResultsFile, type CreatedStaffRecord, type FailedStaffRecord } from '../services/staffBulkImportResults';
import { logger } from '../config/logger';
import { getSchoolName, welcomeEmailBody } from '../services/welcomeEmail';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const ROLES = ['super_admin', 'principal', 'teacher', 'parent', 'student', 'registrar', 'bursar'] as const;
// super_admin is intentionally excluded — creating platform admins must go through /auth/create-user
const CREATABLE_ROLES = ['principal', 'teacher', 'parent', 'student', 'registrar', 'bursar'] as const;

// ── Schemas ────────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page:   z.coerce.number().int().min(1).optional().default(1),
  limit:  z.coerce.number().int().min(1).max(100).optional().default(25),
  role:   z.enum(ROLES).optional(),
  search: z.string().max(255).optional(),
});

const createUserSchema = z.object({
  email:        z.string().trim().toLowerCase().email('Enter a valid email address'),
  first_name:   z.string().min(1).max(255),
  last_name:    z.string().min(1).max(255),
  role:         z.enum(CREATABLE_ROLES),
  title:        z.string().max(20).optional().nullable(),
  phone:        z.string().max(50).optional().nullable(),
  teacher_mode: z.enum(['class', 'subject']).optional(),
}).superRefine((data, ctx) => {
  if (data.role === 'teacher' && !data.teacher_mode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select a teaching mode for this teacher', path: ['teacher_mode'] });
  }
});

const patchUserSchema = z.object({
  first_name: z.string().min(1).max(255).optional(),
  last_name:  z.string().min(1).max(255).optional(),
  phone:      z.string().max(50).optional().nullable(),
  title:      z.string().max(20).optional().nullable(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const statusSchema = z.object({
  is_active: z.boolean(),
  reason: z.string().min(10, 'Reason must be at least 10 characters').optional(),
});

const changeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

// ── Middleware: super_admin or the school's own principal ──────────────────────

function requireSchoolAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.role === 'super_admin') { next(); return; }
  if (user.role === 'principal' && user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

function generateTempPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}


// ── GET /:schoolId/users ───────────────────────────────────────────────────────

router.get(
  '/:schoolId/users',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { page, limit, role, search } = parsed.data;
      const result = await listUsers(req.params.schoolId, { page, limit, role, search });
      return res.json({ success: true, data: result });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/users ──────────────────────────────────────────────────────

router.post(
  '/:schoolId/users',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Defense-in-depth: block super_admin creation before schema parsing.
      if (req.body?.role === 'super_admin') {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'super_admin accounts must be created by the platform root admin' },
        });
      }

      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { email, first_name, last_name, role, title, phone, teacher_mode } = parsed.data;

      const existing = await findUserByEmail(email);
      if (existing) {
        return res.status(409).json({ success: false, error: { code: 'DUPLICATE_EMAIL', message: `A user with email "${email}" already exists` } });
      }

      const tempPassword = generateTempPassword();

      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { first_name, last_name, role, school_id: req.params.schoolId, title, teacher_mode },
      });
      if (authError || !authData?.user) {
        return res.status(500).json({ success: false, error: { code: 'AUTH_CREATE_FAILED', message: authError?.message ?? 'Failed to create authentication account' } });
      }

      const passwordHash = bcrypt.hashSync(tempPassword, 12);
      const user = await insertUser(authData.user.id, req.params.schoolId, {
        email,
        passwordHash,
        role,
        first_name,
        last_name,
        title: title ?? null,
        teacher_mode: role === 'teacher' ? (teacher_mode ?? 'subject') : 'subject',
        phone: phone ?? null,
      });

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'USER_CREATE',
        entity: 'users',
        entityId: user.id,
        newValue: { email: user.email, role: user.role, teacher_mode: user.teacher_mode },
      });

      return res.status(201).json({ success: true, data: { user, temp_password: tempPassword } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/users/:userId ─────────────────────────────────────────────
// Updates name, phone, title only — role and teacher_mode are immutable after creation.

router.patch(
  '/:schoolId/users/:userId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = patchUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findUserById(req.params.userId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }

      const updated = await updateUserProfile(req.params.userId, req.params.schoolId, parsed.data);

      await logSettingsChange(
        req.params.schoolId,
        req.user!.user_id,
        'user_profile',
        { user_id: existing.id, first_name: existing.first_name, last_name: existing.last_name, phone: existing.phone, title: existing.title },
        { user_id: updated.id, first_name: updated.first_name, last_name: updated.last_name, phone: updated.phone, title: updated.title }
      );

      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/users/:userId/status ──────────────────────────────────────
// Toggles is_active. Deactivated users cannot log in.

router.patch(
  '/:schoolId/users/:userId/status',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findUserById(req.params.userId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }

      const updated = await setUserActive(req.params.userId, req.params.schoolId, parsed.data.is_active);

      // Immediately update the is_active cache so verifyToken blocks the user on the next request
      if (redis) {
        await redis.set(`user_active:${req.params.userId}`, parsed.data.is_active ? '1' : '0', 'EX', 300);
      }

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: parsed.data.is_active ? 'USER_REACTIVATED' : 'USER_SUSPENDED',
        entity: 'users',
        entityId: existing.id,
        oldValue: { is_active: existing.is_active },
        newValue: { is_active: updated.is_active, reason: parsed.data.reason },
      });

      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/users/:userId/email ────────────────────────────────────────
// Reassigns an account to a new email address — e.g. a principal resigns and a
// replacement needs to take over the same account. super_admin only: this is
// account-takeover-equivalent power, well above normal staff management.
//
// Also rotates the password to a fresh random value the caller never sees —
// changing only the email would leave the departing holder able to log in as
// the new owner with their already-known (unchanged) password, the moment
// they learn the new address. Pair with POST .../reset-password afterward so
// the new owner can set their own (it emails the link to whatever email is on
// the account at call time, so it reaches the new address once this runs).
//
// The local row and Supabase Auth are updated inside one transaction
// (reassignUserEmail) so the two identity stores can never end up holding
// different emails/passwords for the same account.

router.patch(
  '/:schoolId/users/:userId/email',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = changeEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { email, reason } = parsed.data;

      const existing = await findUserById(req.params.userId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }
      if (existing.role === 'super_admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'super_admin accounts cannot be reassigned through the school router' } });
      }

      if (email !== existing.email) {
        const duplicate = await findUserByEmail(email);
        if (duplicate) {
          return res.status(409).json({ success: false, error: { code: 'DUPLICATE_EMAIL', message: `A user with email "${email}" already exists` } });
        }
      }

      const throwawayPassword = generateTempPassword();
      const passwordHash = bcrypt.hashSync(throwawayPassword, 12);

      const result = await reassignUserEmail(
        req.params.userId,
        req.params.schoolId,
        email,
        passwordHash,
        async () => {
          const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, { email, email_confirm: true, password: throwawayPassword });
          return { ok: !error, error: error?.message };
        }
      );

      if (!result.ok) {
        if (result.error === 'not_found') {
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
        }
        return res.status(500).json({ success: false, error: { code: 'AUTH_UPDATE_FAILED', message: result.error } });
      }

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'USER_EMAIL_CHANGED',
        entity: 'users',
        entityId: existing.id,
        oldValue: { email: existing.email, role: existing.role },
        newValue: { email: result.user.email, reason },
      });

      return res.json({ success: true, data: result.user });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/users/:userId/reset-password ───────────────────────────────
// Generates a Supabase recovery link for the user (does not change their password directly).

router.post(
  '/:schoolId/users/:userId/reset-password',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await findUserById(req.params.userId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }

      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: existing.email,
      });
      if (error) {
        return res.status(500).json({ success: false, error: { code: 'RESET_LINK_FAILED', message: error.message } });
      }

      const actionLink = data?.properties?.action_link;
      if (!actionLink) {
        return res.status(500).json({ success: false, error: { code: 'RESET_LINK_FAILED', message: 'Failed to generate reset link' } });
      }

      // Email the link directly — never return it in the response body.
      sendEmail(
        existing.email,
        'Password Reset Request',
        `A password reset has been requested for your Chronix Edu account.\n\nClick the link below to reset your password:\n\n${actionLink}\n\nThis link expires shortly. If you did not request this, you can safely ignore this email.`
      ).catch(() => {});

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'USER_PASSWORD_RESET_LINK',
        entity: 'users',
        entityId: existing.id,
      });

      return res.json({ success: true, data: { sent: true } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/users/:userId/signature ────────────────────────────────────
// Uploads a teacher's signature image, rendered on report cards as the
// "Class Teacher's Signature & Date" for classes where they are the form teacher.

router.post(
  '/:schoolId/users/:userId/signature',
  verifyToken,
  requireSchoolAccess,
  upload.single('signature'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isSelf = req.user!.user_id === req.params.userId;
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'principal';
      if (!isSelf && !isAdmin) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const existing = await findUserById(req.params.userId, req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "signature".' } });
      }

      const detected = await fileTypeFromBuffer(file.buffer);
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!detected || !allowedMimes.includes(detected.mime)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'File must be JPEG, PNG, or WebP.' } });
      }
      const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const ext = extMap[detected.mime] ?? 'jpg';
      const storagePath = `schools/${req.params.schoolId}/signatures/${req.params.userId}.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: detected.mime, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const signatureUrl = urlData.publicUrl;

      await updateUserSignature(req.params.userId, req.params.schoolId, signatureUrl);

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'TEACHER_SIGNATURE_UPLOAD',
        entity: 'users',
        entityId: existing.id,
        newValue: { signature_url: signatureUrl },
      });

      return res.json({ success: true, data: { signature_url: signatureUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/staff-bulk-import/preview ───────────────────────────────
// Parses and validates a flat staff spreadsheet without writing anything —
// the principal confirms via /staff-bulk-import/commit afterward. See
// docs/superpowers/specs/2026-08-20-staff-bulk-import-design.md for the
// full design rationale.

const MAX_STAFF_BULK_IMPORT_ROWS = 50;
const staffBulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post(
  '/:schoolId/staff-bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  staffBulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      // Magic-byte check only applies to .xlsx — plain-text CSV has no reliable
      // magic-byte signature, matching the Students & Parents bulk import.
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
        parsedRows = await parseStaffBulkImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof StaffBulkImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        return res.status(400).json({
          success: false,
          error: { code: 'PARSE_ERROR', message: 'This file could not be read. Please check it is a valid .xlsx or .csv file.' },
        });
      }

      if (parsedRows.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No staff rows were found in this file.' } });
      }
      if (parsedRows.length > MAX_STAFF_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${parsedRows.length} rows — the maximum per import is ${MAX_STAFF_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const results = await runFullStaffValidation(parsedRows, findUsersRolesByEmails);
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

// ── POST /:schoolId/staff-bulk-import/commit ────────────────────────────────
// Re-validates every row from scratch — never trusts the client-supplied
// "valid"/"error" status from preview. Each row is one Supabase Auth
// createUser() call followed by one local insertUser() call, each wrapped
// in its own try/catch so one bad row can't stop the rest of the batch. If
// createUser() succeeds but insertUser() then fails, the resulting orphaned
// Supabase Auth account is an accepted, pre-existing risk — the single-item
// POST /:schoolId/users route has the identical two-call sequence with no
// rollback today.

const STAFF_BULK_IMPORT_PASSWORD = 'Password2$';
const STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE = 50;

const staffBulkImportCommitSchema = z.object({
  rows: z.array(z.object({
    row_number: z.number(),
    status: z.enum(['valid', 'error']),
    errors: z.array(z.string()),
    staff: z.object({
      row_number: z.number(),
      email: z.string(),
      first_name: z.string(),
      last_name: z.string(),
      role: z.string(),
      title: z.string().nullable(),
      phone: z.string().nullable(),
      teacher_mode: z.string().nullable(),
    }),
  })).min(1).max(MAX_STAFF_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/staff-bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = staffBulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const submittedRows = parsed.data.rows.map(r => r.staff);
      const revalidated = await runFullStaffValidation(submittedRows, findUsersRolesByEmails);

      const results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdStaff: CreatedStaffRecord[] = [];
      const failedStaff: FailedStaffRecord[] = [];

      // Hashed once, outside the loop: STAFF_BULK_IMPORT_PASSWORD is a fixed
      // constant string, so hashing it per-row is redundant work (bcrypt's
      // embedded salt makes each call's output usable identically regardless
      // of whether it's shared across rows) and, at cost 12, ~200-300ms of
      // synchronous CPU per call — blocking this single-process API's event
      // loop for every other school's requests across a 50-row batch.
      const staffPasswordHash = bcrypt.hashSync(STAFF_BULK_IMPORT_PASSWORD, 12);

      for (const row of revalidated) {
        if (row.status === 'error') {
          const reason = row.errors.join(' ');
          results.push({ row_number: row.row_number, status: 'failed', reason });
          failedStaff.push({ row_number: row.row_number, first_name: row.staff.first_name, last_name: row.staff.last_name, email: row.staff.email, role: row.staff.role, reason });
          continue;
        }

        const staff = row.staff;
        const role = staff.role as typeof STAFF_ROLES[number];
        const teacherMode = role === 'teacher' ? (staff.teacher_mode as 'class' | 'subject') : 'subject';

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email: staff.email,
          password: STAFF_BULK_IMPORT_PASSWORD,
          email_confirm: true,
          user_metadata: { first_name: staff.first_name, last_name: staff.last_name, role, school_id: req.params.schoolId, title: staff.title, teacher_mode: teacherMode },
        });
        if (authError || !authData?.user) {
          const reason = authError?.message ?? 'Failed to create authentication account.';
          results.push({ row_number: staff.row_number, status: 'failed', reason });
          failedStaff.push({ row_number: staff.row_number, first_name: staff.first_name, last_name: staff.last_name, email: staff.email, role: staff.role, reason });
          continue;
        }

        let insertedUser;
        try {
          insertedUser = await insertUser(authData.user.id, req.params.schoolId, {
            email: staff.email,
            passwordHash: staffPasswordHash,
            role,
            first_name: staff.first_name,
            last_name: staff.last_name,
            title: staff.title,
            teacher_mode: teacherMode,
            phone: staff.phone,
          });
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'An account with this email already exists.'
            : 'Failed to create this record.';
          results.push({ row_number: staff.row_number, status: 'failed', reason });
          failedStaff.push({ row_number: staff.row_number, first_name: staff.first_name, last_name: staff.last_name, email: staff.email, role: staff.role, reason });
          continue;
        }

        // The account write already succeeded (both the Supabase Auth identity
        // and the local users row) — this row is created regardless of what
        // happens next. An audit-log failure below must never retroactively
        // mark it "failed": a retry would attempt to re-create the same
        // Supabase Auth account and email, colliding with the one that already
        // exists.
        results.push({ row_number: staff.row_number, status: 'created' });
        createdStaff.push({ row_number: staff.row_number, first_name: staff.first_name, last_name: staff.last_name, email: staff.email, role });

        try {
          await logAudit({
            supportSession: req.supportSession,
            schoolId: req.params.schoolId,
            userId: req.user!.user_id,
            actionType: 'USER_CREATE',
            entity: 'users',
            entityId: insertedUser.id,
            newValue: { email: insertedUser.email, role: insertedUser.role, teacher_mode: insertedUser.teacher_mode },
          });
        } catch (auditErr) {
          logger.error('staff_bulk_import_user_create_audit_log_failed', { schoolId: req.params.schoolId, userId: insertedUser.id, err: auditErr });
        }
      }

      if (createdStaff.length > 0) {
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        getSchoolName(req.params.schoolId).then(async schoolName => {
          for (let i = 0; i < createdStaff.length; i += STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE) {
            const batch = createdStaff.slice(i, i + STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE);
            await Promise.all(
              batch.map(s => sendEmail(
                s.email,
                'Welcome to Chronix Edu — Your Staff Account is Ready',
                welcomeEmailBody({ role: s.role, name: `${s.first_name} ${s.last_name}`, email: s.email, tempPassword: STAFF_BULK_IMPORT_PASSWORD, schoolName, appUrl, introVerb: 'added' })
              ).catch(() => {}))
            );
            if (i + STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE < createdStaff.length) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }).catch(() => {});
      }

      // Never let a post-write side effect turn an already-successful commit
      // into an apparent 500 — every account has already been created by this
      // point, so a principal seeing an error here would reasonably re-upload
      // the file, risking duplicate Supabase Auth accounts. Degrade gracefully.
      let resultsFile: Buffer | null = null;
      try {
        resultsFile = await generateStaffBulkImportResultsFile(createdStaff, failedStaff);
      } catch (err) {
        logger.error('staff_bulk_import_results_file_failed', { schoolId: req.params.schoolId, err });
      }

      try {
        await logAudit({
          supportSession: req.supportSession,
          schoolId: req.params.schoolId,
          userId: req.user!.user_id,
          actionType: 'STAFF_BULK_IMPORT',
          entity: 'users',
          entityId: req.params.schoolId,
          newValue: { created: createdStaff.length, failed: results.filter(r => r.status === 'failed').length },
        });
      } catch (auditErr) {
        logger.error('staff_bulk_import_summary_audit_log_failed', { schoolId: req.params.schoolId, err: auditErr });
      }

      return res.json({
        success: true,
        data: {
          created: createdStaff.length,
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

export default router;
