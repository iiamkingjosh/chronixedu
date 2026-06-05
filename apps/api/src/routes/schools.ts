import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
} from '../db/queries/schools';
import { logAudit } from '../db/queries/auditLog';
import { NIGERIAN_DEFAULTS, slugify, validateGradeBands } from '../services/schoolService';
import { supabaseAdmin } from '../supabaseClient';

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
      const school = await findSchoolById(req.params.schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }
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

      await logAudit({
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

      const hasPublished = await checkPublishedResultsExist(req.params.schoolId);
      if (hasPublished) {
        return res.status(423).json({
          success: false,
          error: { code: 'CONFIG_LOCKED', message: 'Academic config cannot be changed while published results exist for the current term.' },
        });
      }

      const hasSubmitted = await checkSubmittedResultsExist(req.params.schoolId);
      const warnings: string[] = [];
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

      const responseData: Record<string, unknown> = { message: 'Academic config updated' };
      if (warnings.length > 0) responseData.warnings = warnings;

      return res.json({ success: true, data: responseData });
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

      const allowed = ['image/jpeg', 'image/png'];
      if (!allowed.includes(file.mimetype)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_FILE_TYPE', message: 'Only JPEG and PNG files are allowed.' } });
      }

      const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
      const storagePath = `schools/${req.params.schoolId}/logo.${ext}`;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'school-assets';

      const { error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: true });

      if (uploadError) {
        return res.status(500).json({ success: false, error: { code: 'UPLOAD_FAILED', message: uploadError.message } });
      }

      const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
      const logoUrl = urlData.publicUrl;

      await updateIdentityConfig(req.params.schoolId, { logo_url: logoUrl });

      await logAudit({
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

export default router;
