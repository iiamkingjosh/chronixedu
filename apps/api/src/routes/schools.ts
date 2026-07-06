import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  updateNotificationConfig,
  updateReportConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
} from '../db/queries/schools';
import { logAudit, logSettingsChange } from '../db/queries/auditLog';
import { NIGERIAN_DEFAULTS, slugify, validateGradeBands } from '../services/schoolService';
import { cache, schoolCacheKey } from '../services/cacheService';
import { supabaseAdmin } from '../supabaseClient';
import { sendEmail, isEmailConfigured } from '../services/emailService';
import { generateReportCardPreview } from '../services/reportCardService';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Zod schemas ────────────────────────────────────────────────────────────────

const createSchoolSchema = z.object({
  name: z.string().min(1).max(255),
  motto: z.string().max(500).optional(),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  secondary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
});

const updateIdentitySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  motto: z.string().max(500).optional(),
  logo_url: z.string().url().optional(),
  stamp_url: z.string().url().optional(),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  secondary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  admission_prefix: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Must be alphanumeric').optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const gradeBandSchema = z.object({
  grade: z.string().min(1),
  min: z.number().int().min(0).max(100),
  max: z.number().int().min(0).max(100),
  label: z.string().min(1),
  remark: z.string(),
});

const updateAcademicSchema = z.object({
  grading_scale: z.array(gradeBandSchema).min(1).optional(),
  promotion_cutoff: z.number().int().min(0).max(100).optional(),
  assessment_components: z.array(z.object({
    name: z.string().min(1),
    max_score: z.number().int().positive(),
    weight: z.number().int().positive(),
    display_order: z.number().int().positive(),
  })).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const notificationChannelsSchema = z.object({
  in_app: z.boolean(),
  email: z.boolean(),
  sms: z.boolean(),
});

const updateNotificationSchema = z.object({
  attendance_alert_threshold: z.number().int().min(1).max(30).optional(),
  attendance_alert_window_days: z.number().int().min(1).max(60).optional(),
  events: z.record(z.string(), notificationChannelsSchema).optional(),
  sms_sender_name: z.string().trim().min(1).max(11).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const reportConfigFieldsSchema = z.object({
  template: z.enum(['classic', 'modern']).optional(),
  show_attendance: z.boolean().optional(),
  footer_text: z.string().max(200).optional(),
  next_term_resumption: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a valid date (YYYY-MM-DD)').nullable().optional(),
});

const updateReportConfigSchema = reportConfigFieldsSchema
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

// ── Middleware: allow super_admin or the school's own principal ────────────────

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

// ── POST /api/schools ──────────────────────────────────────────────────────────

router.post(
  '/',
  verifyToken,
  requireRole('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchoolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { name, motto, primary_colour, secondary_colour } = parsed.data;
      const slug = slugify(name);

      const school = await insertSchool(name, slug);

      const identityConfig: Record<string, unknown> = {
        name,
        motto: motto ?? '',
        logo_url: null,
        stamp_url: null,
        primary_colour: primary_colour ?? null,
        secondary_colour: secondary_colour ?? null,
      };

      const settings = await insertSchoolSettings(school.id, identityConfig, NIGERIAN_DEFAULTS as unknown as Record<string, unknown>);

      return res.status(201).json({ success: true, data: { school, settings } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /api/schools/:schoolId ─────────────────────────────────────────────────

router.get(
  '/:schoolId',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = schoolCacheKey(req.params.schoolId, 'data');
      const school = await cache.wrap(cacheKey, cache.TTL.SCHOOL, () => findSchoolById(req.params.schoolId));
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({ success: true, data: school });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /api/schools/:schoolId/identity ─────────────────────────────────────

router.patch(
  '/:schoolId/identity',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateIdentitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findSchoolById(req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const patch = parsed.data as Record<string, unknown>;
      await updateIdentityConfig(req.params.schoolId, patch);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'IDENTITY_UPDATE',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        oldValue: existing.identity_config,
        newValue: { ...existing.identity_config, ...patch },
      });

      return res.json({ success: true, data: { message: 'Identity updated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /api/schools/:schoolId/academic-config ──────────────────────────────

router.patch(
  '/:schoolId/academic-config',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateAcademicSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { grading_scale, promotion_cutoff, assessment_components } = parsed.data;

      if (grading_scale) {
        const bandError = validateGradeBands(grading_scale);
        if (bandError) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_GRADE_BANDS', message: bandError } });
        }
      }

      const [hasPublished, hasSubmitted] = await Promise.all([
        checkPublishedResultsExist(req.params.schoolId),
        checkSubmittedResultsExist(req.params.schoolId),
      ]);

      const warnings: string[] = [];
      if (hasPublished) {
        warnings.push('Published results exist for the current term. Grade labels will differ if results are re-processed with the new scale.');
      }
      if (hasSubmitted) {
        warnings.push('Submitted results exist for the current term. Changing the grading scale will not retroactively recalculate those results.');
      }

      if (assessment_components) {
        const total = assessment_components.reduce((sum, c) => sum + c.weight, 0);
        if (total !== 100) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Assessment component weights must sum to 100. Got ${total}.` } });
        }
      }

      const patch: Record<string, unknown> = {};
      if (grading_scale) patch.grading_scale = grading_scale;
      if (promotion_cutoff !== undefined) patch.promotion_cutoff = promotion_cutoff;
      if (assessment_components) patch.assessment_components = assessment_components;

      await updateAcademicConfig(req.params.schoolId, patch);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logSettingsChange(
        req.params.schoolId,
        req.user!.user_id,
        Object.keys(patch).join(','),
        null,
        patch
      );

      const responseData: Record<string, unknown> = { message: 'Academic config updated' };
      if (warnings.length > 0) responseData.warnings = warnings;

      return res.json({ success: true, data: responseData });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /api/schools/:schoolId/notification-config ──────────────────────────

router.patch(
  '/:schoolId/notification-config',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateNotificationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findSchoolById(req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const { attendance_alert_threshold, attendance_alert_window_days, events, sms_sender_name } = parsed.data;
      const existingConfig = existing.notification_config ?? {};

      const patch: Record<string, unknown> = {};

      if (attendance_alert_threshold !== undefined || attendance_alert_window_days !== undefined) {
        const existingAlert = (existingConfig.attendance_alert as Record<string, unknown>) ?? {};
        patch.attendance_alert = {
          ...existingAlert,
          ...(attendance_alert_threshold !== undefined ? { threshold: attendance_alert_threshold } : {}),
          ...(attendance_alert_window_days !== undefined ? { window_days: attendance_alert_window_days } : {}),
        };
      }

      if (events) {
        const existingEvents = (existingConfig.events as Record<string, unknown>) ?? {};
        patch.events = { ...existingEvents, ...events };
      }

      if (sms_sender_name !== undefined) {
        patch.sms_sender_name = sms_sender_name;
      }

      await updateNotificationConfig(req.params.schoolId, patch);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logSettingsChange(
        req.params.schoolId,
        req.user!.user_id,
        Object.keys(patch).join(','),
        existingConfig,
        patch
      );

      return res.json({ success: true, data: { message: 'Notification settings updated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /api/schools/:schoolId/report-config ────────────────────────────────

router.patch(
  '/:schoolId/report-config',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateReportConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existing = await findSchoolById(req.params.schoolId);
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const patch = parsed.data as Record<string, unknown>;
      await updateReportConfig(req.params.schoolId, patch);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logSettingsChange(
        req.params.schoolId,
        req.user!.user_id,
        Object.keys(patch).join(','),
        existing.report_config,
        patch
      );

      return res.json({ success: true, data: { message: 'Report card settings updated' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/report-config/preview ─────────────────────────

router.post(
  '/:schoolId/report-config/preview',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reportConfigFieldsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const school = await findSchoolById(req.params.schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const pdfBuffer = await generateReportCardPreview(req.params.schoolId, parsed.data);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="report-card-preview.pdf"');
      return res.send(pdfBuffer);
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/notifications/test-email ──────────────────────

router.post(
  '/:schoolId/notifications/test-email',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = req.user?.email;
      if (!email) {
        return res.status(400).json({ success: false, error: { code: 'NO_EMAIL', message: 'No email address found for the current user' } });
      }

      if (!isEmailConfigured()) {
        return res.status(400).json({ success: false, error: { code: 'EMAIL_NOT_CONFIGURED', message: 'SendGrid is not configured (SENDGRID_API_KEY missing).' } });
      }

      await sendEmail(
        email,
        'Chronix Edu — Test Email',
        'This is a test email from Chronix Edu confirming your SendGrid configuration is working correctly.'
      );

      return res.json({ success: true, data: { message: `Test email sent to ${email}` } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/logo ──────────────────────────────────────────

router.post(
  '/:schoolId/logo',
  verifyToken,
  requireSchoolAccess,
  upload.single('logo'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const school = await findSchoolById(req.params.schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "logo".' } });
      }

      const detected = await fileTypeFromBuffer(file.buffer);
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!detected || !allowedMimes.includes(detected.mime)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'File must be JPEG, PNG, or WebP.' } });
      }
      const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const ext = extMap[detected.mime] ?? 'jpg';
      const storagePath = `schools/${req.params.schoolId}/logo.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: detected.mime, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const logoUrl = urlData.publicUrl;

      await updateIdentityConfig(req.params.schoolId, { logo_url: logoUrl });
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'LOGO_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { logo_url: logoUrl },
      });

      return res.json({ success: true, data: { logo_url: logoUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/signature ─────────────────────────────────────

router.post(
  '/:schoolId/signature',
  verifyToken,
  requireSchoolAccess,
  upload.single('signature'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const school = await findSchoolById(req.params.schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
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
      const storagePath = `schools/${req.params.schoolId}/signature.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: detected.mime, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const signatureUrl = urlData.publicUrl;

      await updateIdentityConfig(req.params.schoolId, { signature_url: signatureUrl });
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'SIGNATURE_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { signature_url: signatureUrl },
      });

      return res.json({ success: true, data: { signature_url: signatureUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/stamp ─────────────────────────────────────────

router.post(
  '/:schoolId/stamp',
  verifyToken,
  requireSchoolAccess,
  upload.single('stamp'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const school = await findSchoolById(req.params.schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "stamp".' } });
      }

      const detected = await fileTypeFromBuffer(file.buffer);
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!detected || !allowedMimes.includes(detected.mime)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'File must be JPEG, PNG, or WebP.' } });
      }
      const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const ext = extMap[detected.mime] ?? 'jpg';
      const storagePath = `schools/${req.params.schoolId}/stamp.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: detected.mime, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const stampUrl = urlData.publicUrl;

      await updateIdentityConfig(req.params.schoolId, { stamp_url: stampUrl });
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'STAMP_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { stamp_url: stampUrl },
      });

      return res.json({ success: true, data: { stamp_url: stampUrl } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
