import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import multer from 'multer';
import { verifyToken, requireRole } from '../middleware/auth';
import { supabaseAdmin } from '../supabaseClient';
import { logAudit, logSettingsChange } from '../db/queries/auditLog';
import {
  listUsers,
  findUserById,
  findUserByEmail,
  insertUser,
  updateUserProfile,
  setUserActive,
  updateUserSignature,
} from '../db/queries/users';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const ROLES = ['super_admin', 'principal', 'teacher', 'parent', 'student', 'registrar', 'bursar'] as const;

// ── Schemas ────────────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page:   z.coerce.number().int().min(1).optional().default(1),
  limit:  z.coerce.number().int().min(1).max(100).optional().default(25),
  role:   z.enum(ROLES).optional(),
  search: z.string().max(255).optional(),
});

const createUserSchema = z.object({
  email:        z.string().email('Enter a valid email address'),
  first_name:   z.string().min(1).max(255),
  last_name:    z.string().min(1).max(255),
  role:         z.enum(ROLES),
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

      const actionLink = data?.properties?.action_link ?? null;

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'USER_PASSWORD_RESET_LINK',
        entity: 'users',
        entityId: existing.id,
      });

      return res.json({ success: true, data: { reset_link: actionLink } });
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

      const allowed = ['image/jpeg', 'image/png'];
      if (!allowed.includes(file.mimetype)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'Only JPEG and PNG files are allowed.' } });
      }

      const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
      const storagePath = `schools/${req.params.schoolId}/signatures/${req.params.userId}.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });

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

export default router;
