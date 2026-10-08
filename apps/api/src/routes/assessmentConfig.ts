import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { verifyToken, requireRole } from '../middleware/auth';
import { clientIp } from '../middleware/clientIp';
import { logSettingsChange, logAudit } from '../db/queries/auditLog';
import pool from '../db/client';
import {
  insertAssessmentConfig,
  listAssessmentConfigs,
  findConfigById,
  resolveAssessmentConfig,
  scoresExistForConfigTerm,
  scoresExistForTerm,
  updateAssessmentConfig,
  findSchoolTerm,
  subjectBelongsToSchool,
  copyAssessmentConfigs,
  termHasConfig,
  deleteAssessmentConfig,
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

const copySchema = z.object({
  from_term_id: z.string().uuid(),
  to_term_id:   z.string().uuid(),
}).refine(v => v.from_term_id !== v.to_term_id, { message: 'Choose two different terms' });

const LOCKED_MESSAGE = 'Scores have already been entered for this term, so its assessment structure is locked. Adding or removing a structure would change how those scores are read.';

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
      const schoolId = req.params.schoolId;

      const total = sumWeights(components);
      if (Math.round(total * 100) !== 10000) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_WEIGHTS', message: `Component weight_percent values must sum to exactly 100. Got ${total}.` },
        });
      }

      // A structure names this school's own term and subject (doctrine 3: validate the target).
      if (!(await findSchoolTerm(term_id, schoolId))) {
        return res.status(404).json({ success: false, error: { code: 'TERM_NOT_FOUND', message: 'Term not found in this school' } });
      }
      if (subject_id && !(await subjectBelongsToSchool(subject_id, schoolId))) {
        return res.status(404).json({ success: false, error: { code: 'SUBJECT_NOT_FOUND', message: 'Subject not found in this school' } });
      }
      // Same lock as editing: a new structure for a term with scores could take over a subject
      // whose scores were entered against another structure's components.
      if (await scoresExistForTerm(term_id, schoolId)) {
        return res.status(423).json({ success: false, error: { code: 'CONFIG_LOCKED', message: LOCKED_MESSAGE } });
      }

      const config = await insertAssessmentConfig(
        schoolId,
        term_id,
        subject_id ?? null,
        class_level ?? null,
        is_default,
        components
      );

      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId,
        userId: req.user!.user_id,
        actionType: 'ASSESSMENT_CONFIG_CREATED',
        entity: 'assessment_configs',
        entityId: config.id,
        newValue: { config_id: config.id, term_id, subject_id: subject_id ?? null, class_level: class_level ?? null, is_default, components },
      });

      return res.status(201).json({ success: true, data: config });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/assessment-config/copy-from-term ──────────────────────────
// Gives a term with no structure a copy of another term's. A new term is given one when it is
// created; this is for a term that already exists without one (audit, 8 Oct 2026).

router.post(
  '/:schoolId/assessment-config/copy-from-term',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = copySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { from_term_id, to_term_id } = parsed.data;
      const schoolId = req.params.schoolId;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The target term's row is locked, so two copies at once cannot both find it empty.
        const target = await client.query<{ id: string }>(
          `SELECT id FROM terms WHERE id = $1 AND school_id = $2 FOR UPDATE`, [to_term_id, schoolId]);
        const source = await findSchoolTerm(from_term_id, schoolId, client);
        if (!target.rows[0] || !source) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: { code: 'TERM_NOT_FOUND', message: 'Term not found in this school' } });
        }
        if (await termHasConfig(client, to_term_id, schoolId)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: { code: 'TARGET_HAS_CONFIG', message: 'This term already has an assessment structure. Change it instead of copying over it.' },
          });
        }
        const configs = await copyAssessmentConfigs(client, schoolId, from_term_id, to_term_id);
        if (configs === 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: { code: 'NOTHING_TO_COPY', message: `${source.name} has no assessment structure to copy.` },
          });
        }
        await logAudit({
          ipAddress: clientIp(req) ?? null,
          supportSession: req.supportSession,
          schoolId,
          userId: req.user!.user_id,
          actionType: 'ASSESSMENT_CONFIG_COPIED',
          entity: 'assessment_configs',
          entityId: to_term_id,
          newValue: { from_term_id, to_term_id, configs, reason: 'copied_by_hand' },
        }, client);
        await client.query('COMMIT');
        return res.status(201).json({ success: true, data: { from_term_id, to_term_id, configs } });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
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
        { config_id: updated.id, components: updated.components },
        clientIp(req) ?? null
      );

      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /:schoolId/assessment-config/:configId ─────────────────────────────
// Until scores exist for its term; after that it is locked, as editing is.

router.delete(
  '/:schoolId/assessment-config/:configId',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, configId } = req.params;
      if (!z.string().uuid().safeParse(configId).success) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assessment configuration not found' } });
      }
      const config = await findConfigById(configId, schoolId);
      if (!config) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assessment configuration not found' } });
      }
      if (await scoresExistForTerm(config.term_id, schoolId)) {
        return res.status(423).json({ success: false, error: { code: 'CONFIG_LOCKED', message: LOCKED_MESSAGE } });
      }

      const removed = await deleteAssessmentConfig(configId, schoolId);
      if (!removed) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Assessment configuration not found' } });
      }
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId,
        userId: req.user!.user_id,
        actionType: 'ASSESSMENT_CONFIG_DELETED',
        entity: 'assessment_configs',
        entityId: configId,
        oldValue: {
          config_id: removed.id, term_id: removed.term_id, subject_id: removed.subject_id,
          class_level: removed.class_level, is_default: removed.is_default, components: removed.components,
        },
        newValue: null,
      });

      return res.json({ success: true, data: { deleted: configId } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
