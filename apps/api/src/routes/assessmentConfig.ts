import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { logSettingsChange } from '../db/queries/auditLog';
import {
  insertAssessmentConfig,
  listAssessmentConfigs,
  findConfigById,
  resolveAssessmentConfig,
  scoresExistForConfigTerm,
  updateAssessmentConfig,
} from '../db/queries/assessmentConfig';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────────

const componentSchema = z.object({
  name:          z.string().min(1).max(255),
  max_score:     z.number().positive(),
  weight_percent: z.number().positive(),
  display_order: z.number().int().min(1),
});

const createSchema = z.object({
  term_id:     z.string().uuid(),
  subject_id:  z.string().uuid().optional().nullable(),
  class_level: z.string().max(50).optional().nullable(),
  is_default:  z.boolean().optional().default(false),
  components:  z.array(componentSchema).min(1),
});

const patchSchema = z.object({
  components:  z.array(componentSchema).min(1),
  subject_id:  z.string().uuid().optional().nullable(),
  class_level: z.string().max(50).optional().nullable(),
  is_default:  z.boolean().optional(),
});

const resolveQuerySchema = z.object({
  class_id:   z.string().uuid(),
  subject_id: z.string().uuid(),
  term_id:    z.string().uuid(),
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

function sumWeights(components: z.infer<typeof componentSchema>[]): number {
  return components.reduce((acc, c) => acc + c.weight_percent, 0);
}

// ── POST /:schoolId/assessment-config ──────────────────────────────────────────

router.post(
  '/:schoolId/assessment-config',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { term_id, subject_id, class_level, is_default, components } = parsed.data;

      const total = sumWeights(components);
      if (Math.round(total * 100) !== 10000) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_WEIGHTS', message: `Component weight_percent values must sum to exactly 100. Got ${total}.` },
        });
      }

      const config = await insertAssessmentConfig(
        req.params.schoolId,
        term_id,
        subject_id ?? null,
        class_level ?? null,
        is_default,
        components
      );

      return res.status(201).json({ success: true, data: config });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/assessment-config ──────────────────────────────────────────
// NOTE: registered before /:schoolId/assessment-config/resolve and
// /:schoolId/assessment-config/:configId so Express matches the literal
// "resolve" segment correctly.

router.get(
  '/:schoolId/assessment-config',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const configs = await listAssessmentConfigs(req.params.schoolId);
      return res.json({ success: true, data: configs });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/assessment-config/resolve ──────────────────────────────────

router.get(
  '/:schoolId/assessment-config/resolve',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resolveQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Required query params: class_id (uuid), subject_id (uuid), term_id (uuid)' },
        });
      }

      const { class_id, subject_id, term_id } = parsed.data;

      const config = await resolveAssessmentConfig(req.params.schoolId, class_id, subject_id, term_id);
      if (!config) {
        return res.status(404).json({
          success: false,
          error: { code: 'NO_CONFIG', message: 'No assessment configuration found for this class, subject, and term combination' },
        });
      }

      return res.json({ success: true, data: config });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /:schoolId/assessment-config/:configId ──────────────────────────────

router.patch(
  '/:schoolId/assessment-config/:configId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { components, subject_id, class_level, is_default } = parsed.data;

      const config = await findConfigById(req.params.configId, req.params.schoolId);
      if (!config) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assessment configuration not found' } });
      }

      const total = sumWeights(components);
      if (Math.round(total * 100) !== 10000) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_WEIGHTS', message: `Component weight_percent values must sum to exactly 100. Got ${total}.` },
        });
      }

      const locked = await scoresExistForConfigTerm(req.params.configId, req.params.schoolId);
      if (locked) {
        return res.status(423).json({
          success: false,
          error: { code: 'CONFIG_LOCKED', message: 'Assessment configuration cannot be changed after scores have been entered for this term.' },
        });
      }

      const metadata: Record<string, unknown> = {};
      if ('subject_id' in parsed.data) metadata.subject_id = subject_id ?? null;
      if ('class_level' in parsed.data) metadata.class_level = class_level ?? null;
      if ('is_default' in parsed.data) metadata.is_default = is_default;

      const updated = await updateAssessmentConfig(
        req.params.configId,
        req.params.schoolId,
        components,
        Object.keys(metadata).length > 0 ? metadata as Parameters<typeof updateAssessmentConfig>[3] : undefined
      );

      await logSettingsChange(
        req.params.schoolId,
        req.user!.user_id,
        'assessment_config',
        { config_id: config.id, ...config },
        { config_id: updated.id, components: updated.components }
      );

      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
