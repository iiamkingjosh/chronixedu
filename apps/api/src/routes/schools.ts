import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import { verifyToken, requireRole, type SupportSessionContext } from '../middleware/auth';
import { clientIp } from '../middleware/clientIp';
import { requireFeature } from '../middleware/requireFeature';
import { redis, bestEffort } from '../middleware/rateLimit';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  listClassLevels,
  findAcademicConfig,
  updateNotificationConfig,
  updateReportConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
  getSchoolPayoutConfig,
  updateSchoolPayoutConfig,
  getSchoolNameAndEmail,
  resolveMinPartPayment,
  updateFeeConfig,
  type PayoutConfig,
} from '../db/queries/schools';
import { toKobo, fromKobo } from '../services/money';
import { findPrincipalsBySchool } from '../db/queries/users';
import { logAudit, logSettingsChange } from '../db/queries/auditLog';
import { newSchoolAcademicConfig, slugify, validateGradeBands } from '../services/schoolService';
import { cache, schoolCacheKey } from '../services/cacheService';
import { supabaseAdmin } from '../supabaseClient';
import { passwordMatches } from '../services/passwordCheck';
import { sendEmail, isEmailConfigured } from '../services/emailService';
import { appBaseUrl } from '../config/appUrls';
import { testEmail, TEST_EMAIL_SUBJECT } from '../services/chronixVoiceEmails';
import { generateReportCardPreview } from '../services/reportCardService';
import { listBanks, resolveBankAccount, createPaystackSubaccount, PaystackServiceError } from '../services/paystackService';
import { sendTermiiSms } from '../services/termiiService';
import { logger } from '../config/logger';
import { findSubscriptionGate } from '../db/queries/schools';
import { exportSummary, exportDatasetCsv } from '../db/queries/schoolExport';
import { streamSchoolArchive } from '../services/schoolExportArchive';
import { signAsset, withSignedAssets } from '../services/schoolAssets';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Zod schemas ────────────────────────────────────────────────────────────────

// is_demo is required with no default — see startOnboardingSchema in routes/superAdmin.ts.
const createSchoolSchema = z.object({
  name: z.string().trim().min(1).max(255),
  is_demo: z.boolean({
    error: (issue) => issue.input === undefined
      ? 'is_demo is required: say whether this school is a customer (false) or a demo/test school (true)'
      : 'is_demo must be true or false',
  }),
  motto: z.string().max(500).optional(),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  secondary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
});

/** Identity fields that hold an image: each has its own upload route. */
const IMAGE_FIELDS = ['logo_url', 'stamp_url', 'signature_url'] as const;

const updateIdentitySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  motto: z.string().max(500).optional(),
  primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  secondary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
  admission_prefix: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Must be alphanumeric').optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const resolvePayoutBankSchema = z.object({
  bank_code: z.string().min(1, 'Bank is required'),
  account_number: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
});

const savePayoutSchema = z.object({
  bank_code: z.string().min(1, 'Bank is required'),
  account_number: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  account_name: z.string().min(1, 'Account name is required'),
  // Step-up confirmation: redirecting where a school's fee settlement lands is
  // high-stakes enough that role membership (principal/super_admin) alone isn't
  // sufficient — the caller must re-prove they are who their session claims by
  // re-entering their own password, verified the same way login does.
  current_password: z.string().min(1, 'Your current password is required to confirm this change'),
});

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
  // Per-class-level overrides of the two fields above, keyed by classes.level, for a
  // school running more than one section (e.g. a primary and a secondary arm) that
  // needs a different pass mark or grading band for each. Omitted fields fall back to
  // the school-wide values; an empty object clears all overrides.
  level_overrides: z.record(
    z.string().min(1).max(50),
    z.object({
      grading_scale: z.array(gradeBandSchema).min(1).optional(),
      promotion_cutoff: z.number().int().min(0).max(100).optional(),
    }).refine(o => Object.keys(o).length > 0, { message: 'An override must set at least one field' })
  ).optional(),
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

// ── Middleware: allow super_admin, or the school's own principal/bursar ────────

function requirePayoutAccess(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return;
  }
  if (user.role === 'super_admin') { next(); return; }
  if ((user.role === 'principal' || user.role === 'bursar') && user.school_id === req.params.schoolId) { next(); return; }
  res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

function maskAccountNumber(accountNumber: string | undefined): string | undefined {
  if (!accountNumber || accountNumber.length < 4) return accountNumber;
  return `••••${accountNumber.slice(-4)}`;
}

// The payout config is already saved by the time this runs — alert delivery must
// never fail the caller's response, so every failure path here is swallowed and
// logged rather than thrown.
async function sendPayoutChangeAlerts(
  schoolId: string,
  changedByEmail: string,
  maskedAccount: string,
  bankCode: string,
  supportSession?: SupportSessionContext
): Promise<void> {
  try {
    const [school, principals] = await Promise.all([
      getSchoolNameAndEmail(schoolId),
      findPrincipalsBySchool(schoolId),
    ]);

    // During a support session req.user is the impersonated school user, so
    // naming them would falsely accuse the school's own staff. Attribute the
    // change to the Chronix platform admin who actually made it.
    const changedBy = supportSession
      ? `a Chronix Edu platform administrator during a support session (signed in as ${changedByEmail})`
      : changedByEmail;
    const message = `Payout bank details for ${school?.name ?? 'your school'} were changed by ${changedBy}. New account ends in ${maskedAccount.slice(-4)} (bank code ${bankCode}). If this wasn't authorised, contact Chronix support immediately.`;

    const alerts: Promise<unknown>[] = [];
    for (const principal of principals) {
      alerts.push(sendEmail(principal.email, 'Payout bank details changed', message));
      if (principal.phone) alerts.push(sendTermiiSms(schoolId, principal.phone, message));
    }
    if (principals.length === 0) {
      logger.warn('payout_change_alert_no_principals', { schoolId });
    }
    if (school?.email) alerts.push(sendEmail(school.email, 'Payout bank details changed', message));
    const rootAdminEmail = process.env.ROOT_ADMIN_EMAIL;
    if (rootAdminEmail) alerts.push(sendEmail(rootAdminEmail, `Payout change — ${school?.name ?? schoolId}`, message));

    const results = await Promise.allSettled(alerts);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('payout_change_alert_failed', {
          schoolId,
          error: result.reason instanceof Error ? result.reason.message : result.reason,
        });
      }
    }
  } catch (err) {
    logger.error('payout_change_alerts_aborted', {
      schoolId,
      error: err instanceof Error ? err.message : err,
    });
  }
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

      const { name, is_demo, motto, primary_colour, secondary_colour } = parsed.data;
      const slug = slugify(name);

      const school = await insertSchool(name, slug, is_demo);

      const identityConfig: Record<string, unknown> = {
        name,
        motto: motto ?? '',
        logo_url: null,
        stamp_url: null,
        primary_colour: primary_colour ?? null,
        secondary_colour: secondary_colour ?? null,
      };

      // No grading scale, pass mark or assessment components: the school sets its own
      // (doctrine 8; services/schoolService.ts newSchoolAcademicConfig).
      const settings = await insertSchoolSettings(school.id, identityConfig, newSchoolAcademicConfig());

      return res.status(201).json({ success: true, data: { school, settings } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /api/schools/:schoolId ─────────────────────────────────────────────────

// ── GET /:schoolId/export, GET /:schoolId/export/:dataset ─────────────────────
// The school's own complete data export (db/queries/schoolExport.ts): the DPA and Terms §22
// promise it, and the read-only notice tells a lapsed school it can still take its data.
// GETs, so they work while read-only. This file's requireSchoolAccess admits the principal
// and super_admin only — deliberately: this is every child's record in one place. Each
// download is audited (doctrine 10: a bulk export of personal data is a sensitive act).
router.get(
  '/:schoolId/export',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json({ success: true, data: { datasets: await exportSummary(req.params.schoolId) } });
    } catch (err) {
      return next(err);
    }
  }
);

// The whole export as one zip: every dataset, every stored file and a manifest
// (services/schoolExportArchive.ts, 3 Oct 2026). Registered before /:dataset, which would
// otherwise read "archive" as a dataset name. Audited BEFORE the first byte, so an export never
// leaves without its record. Once bytes have gone, a failure can no longer become an error
// response; it ends the stream, which the browser shows as a failed download, and is alerted.
router.get(
  '/:schoolId/export/archive',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'SCHOOL_DATA_EXPORTED',
        entity: 'school_export',
        entityId: req.params.schoolId,
        oldValue: null,
        newValue: { dataset: 'archive' },
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="chronix-edu-export-${new Date().toISOString().slice(0, 10)}.zip"`);
      const counts = await streamSchoolArchive(req.params.schoolId, res);
      logger.info('school_export_archive_sent', { school_id: req.params.schoolId, ...counts });
      // What went, so the record can be reconciled with what the school received: the manifest's
      // own figures and its SHA-256. A second row, because audit_logs rows cannot be updated
      // (migrations 036-038) and the first is written before anything is known. Absent if the
      // stream failed, which logs school_export_archive_failed (alerted as school_export_failed).
      try {
        await logAudit({
          ipAddress: clientIp(req) ?? null,
          supportSession: req.supportSession,
          schoolId: req.params.schoolId,
          userId: req.user!.user_id,
          actionType: 'SCHOOL_DATA_EXPORT_COMPLETED',
          entity: 'school_export',
          entityId: req.params.schoolId,
          oldValue: null,
          newValue: { dataset: 'archive', ...counts },
        });
      } catch (auditErr) {
        // The download has gone; the record of what was in it has not. Alerted, never swallowed.
        logger.error('audit_write_failed', { school_id: req.params.schoolId, action: 'SCHOOL_DATA_EXPORT_COMPLETED', error: auditErr instanceof Error ? auditErr.message : String(auditErr) });
      }
    } catch (err) {
      if (!res.headersSent) return next(err);
      logger.error('school_export_archive_failed', { school_id: req.params.schoolId, error: err instanceof Error ? err.message : String(err) });
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
);

router.get(
  '/:schoolId/export/:dataset',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await exportDatasetCsv(req.params.schoolId, req.params.dataset);
      if (!out) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No such export' } });
      }
      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'SCHOOL_DATA_EXPORTED',
        entity: 'school_export',
        entityId: req.params.schoolId,
        oldValue: null,
        newValue: { dataset: req.params.dataset, rows: out.rows },
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      return res.send(out.csv);
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/subscription-status ──────────────────────────────────────
// The trial gate's state, for the in-app notice (migration 046). Every member of the
// school may read it — unlike this file's requireSchoolAccess, which admits principals
// only — so the guard is written here, explicitly (CLAUDE.md doctrine 1). A GET, so it
// still answers while the school is read-only; that is when it matters most.
router.get(
  '/:schoolId/subscription-status',
  (req: Request, res: Response, next: NextFunction) => {
    const u = req.user;
    if (u && (u.role === 'super_admin' || u.school_id === req.params.schoolId)) { next(); return; }
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await findSubscriptionGate(req.params.schoolId);
      if (!r) return res.json({ success: true, data: { state: 'none' } });
      const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
      const state = ['trial', 'grace', 'read_only'].includes(r.subscription_status) ? r.subscription_status : 'active';
      return res.json({
        success: true,
        data: {
          state,
          plan: r.plan,
          trial_end_date: r.trial_end_date,
          grace_last_day: r.grace_last_day,
          // Days of full access left, counting today: through the trial's last day, or
          // through grace's last day. null once read-only.
          days_left: state === 'trial' && r.trial_end_date ? daysBetween(r.today, r.trial_end_date) + 1
            : state === 'grace' && r.grace_last_day ? daysBetween(r.today, r.grace_last_day) + 1
            : null,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

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
      // The logo, stamp and signature are stored as paths in the private bucket. The answer carries
      // links that expire, made for each request; the cached row keeps the paths.
      const identity = (school.identity_config ?? {}) as Record<string, unknown>;
      const shown = await withSignedAssets(identity, ['logo_url', 'stamp_url', 'signature_url']);
      return res.json({ success: true, data: { ...school, identity_config: shown } });
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
      // The images are set by uploading one, never by sending an address. This route took any address
      // for the logo and stamp until 5 Oct 2026, and the PDF renderer then fetched it, so a principal
      // could make the server request an internal address. Refused by name, not silently dropped.
      const sentImage = IMAGE_FIELDS.find(f => req.body && typeof req.body === 'object' && f in req.body);
      if (sentImage) {
        return res.status(400).json({
          success: false,
          error: { code: 'SET_BY_UPLOAD', message: `${sentImage} is set by uploading an image, not by sending an address.` },
        });
      }

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
        ipAddress: clientIp(req) ?? null,
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

// ── GET /api/schools/:schoolId/academic-config/levels ─────────────────────────
// Everything the level-overrides screen needs, in one uncached read.
//
// `classes.level` is free text matched EXACTLY by fetchAcademicConfig and the report
// card, so an override keyed "Jss" or "JSS " for classes whose level is "JSS" silently
// does nothing — no error, the school-wide values just keep applying. The screen
// therefore offers only levels that real classes carry, from this list, and never a
// free-text box. Two further things it could not otherwise see:
//
//   - `orphaned_overrides`: keys that match no class's level. They are live config that
//     affects nothing, which is worse than no config because it looks like a decision.
//   - `near_duplicate_levels`: levels that differ only in case or surrounding spaces
//     ("JSS" / "jss "). Those are two different levels to the resolver, so an override
//     on one does not reach the other's classes.
//
// Read from the row rather than GET /:schoolId, which is cached server-side for five
// minutes and sent with max-age=60. level_overrides is replaced wholesale on save, so a
// screen that re-read a stale copy would write old overrides back over new ones.
//
// Access is this file's requireSchoolAccess: super_admin, or the school's own principal
// — the same people the PATCH admits, so nobody can see a screen they cannot save.

router.get(
  '/:schoolId/academic-config/levels',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const [levels, config] = await Promise.all([listClassLevels(schoolId), findAcademicConfig(schoolId)]);

      const overrides = (config.level_overrides ?? {}) as Record<string, unknown>;
      const known = new Set(levels.map(l => l.level));
      const orphaned_overrides = Object.keys(overrides).filter(k => !known.has(k));

      const byNormalised = new Map<string, string[]>();
      for (const { level } of levels) {
        const key = level.trim().toLowerCase();
        byNormalised.set(key, [...(byNormalised.get(key) ?? []), level]);
      }
      // Sorted here rather than trusting ORDER BY: collation decides whether 'junior '
      // precedes 'Junior', and it differs between databases. The screen should not
      // reorder itself depending on where it is deployed.
      const near_duplicate_levels = [...byNormalised.values()]
        .filter(group => group.length > 1)
        .map(group => [...group].sort());

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        success: true,
        data: {
          levels,
          school_wide: {
            // null means NOT SET, deliberately distinct from any number (doctrine 8): the
            // screen says "no school-wide pass mark" rather than inventing one.
            promotion_cutoff: typeof config.promotion_cutoff === 'number' ? config.promotion_cutoff : null,
            grading_scale: Array.isArray(config.grading_scale) ? config.grading_scale : [],
          },
          level_overrides: overrides,
          orphaned_overrides,
          near_duplicate_levels,
        },
      });
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

      const { grading_scale, promotion_cutoff, assessment_components, level_overrides } = parsed.data;

      if (grading_scale) {
        const bandError = validateGradeBands(grading_scale);
        if (bandError) {
          return res.status(400).json({ success: false, error: { code: 'INVALID_GRADE_BANDS', message: bandError } });
        }
      }

      // Each override's bands must be internally valid too, or a section could be
      // given a scale with gaps or overlaps that the school-wide check would catch.
      for (const [level, override] of Object.entries(level_overrides ?? {})) {
        if (!override.grading_scale) continue;
        const bandError = validateGradeBands(override.grading_scale);
        if (bandError) {
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_GRADE_BANDS', message: `Level "${level}": ${bandError}` },
          });
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
      if (level_overrides !== undefined) patch.level_overrides = level_overrides;

      // The prior value of exactly the patched keys, read in the statement that writes —
      // this was a literal null, so every grading change was audited as having no
      // predecessor.
      const prior = await updateAcademicConfig(req.params.schoolId, patch);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logSettingsChange(
        req.params.schoolId,
        req.user!.user_id,
        Object.keys(patch).join(','),
        prior,
        patch,
        clientIp(req) ?? null
      );

      const responseData: Record<string, unknown> = { message: 'Academic config updated' };
      if (warnings.length > 0) responseData.warnings = warnings;

      return res.json({ success: true, data: responseData });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET / PATCH /api/schools/:schoolId/fee-config ─────────────────────────────
// The school's own fee policy. Currently one field: the smallest part payment a parent
// may make online. The default is Chronix's, and the UI says so — it is a guardrail on
// transaction cost (bearer: 'subaccount' means the school pays the Paystack fee), not a
// claim about any school's policy. A disclosed default is a different object from an
// invented one; compare promotion_cutoff ?? 40, which asserted a school's pass mark on a
// report card silently.

const updateFeeConfigSchema = z.object({
  // Naira, 2 dp, stored as kobo. Matches the payment routes' boundary treatment.
  min_part_payment: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount in naira with at most 2 decimal places')
    .refine(v => Number(v) > 0, 'Minimum part payment must be greater than zero'),
});

router.get(
  '/:schoolId/fee-config',
  verifyToken,
  requireSchoolAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { kobo, isConfigured } = await resolveMinPartPayment(req.params.schoolId);
      return res.json({
        success: true,
        data: {
          min_part_payment: fromKobo(kobo),
          // Read from whether a value was stored, NOT from whether it equals the
          // default — a school that chose ₦1,000 has chosen it.
          is_default: !isConfigured,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.patch(
  '/:schoolId/fee-config',
  verifyToken,
  requireSchoolAccess,
  requireRole('principal', 'bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateFeeConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const patch = { min_part_payment_kobo: toKobo(parsed.data.min_part_payment) };
      const prior = await updateFeeConfig(req.params.schoolId, patch);
      await logSettingsChange(req.params.schoolId, req.user!.user_id, 'min_part_payment_kobo', prior, patch, clientIp(req) ?? null);

      return res.json({ success: true, data: { message: 'Fee settings updated', min_part_payment: parsed.data.min_part_payment } });
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
        patch,
        clientIp(req) ?? null
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
        patch,
        clientIp(req) ?? null
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

      // On the shared layout (2 Oct 2026), so the test shows the real design. And it says what SendGrid
      // did: it used to answer "Test email sent" whatever happened, which defeats a test.
      const mail = testEmail(appBaseUrl());
      const outcome = await sendEmail(email, TEST_EMAIL_SUBJECT, mail.text, mail.html);
      if (outcome !== 'sent') {
        const why = outcome === 'queued'
          ? 'SendGrid did not accept it. It has been queued and will be retried, so it may still arrive.'
          : outcome === 'lost'
            ? 'SendGrid did not accept it, and it could not be queued for a retry.'
            : 'Email is not configured on this server.';
        return res.status(502).json({ success: false, error: { code: 'TEST_EMAIL_NOT_SENT', message: `The test email to ${email} was not sent. ${why}` } });
      }

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

      // The record keeps the file's path in the bucket, never a link: the bucket is private
      // (services/schoolAssets.ts). The answer carries a link that expires, for the screen to show.
      await updateIdentityConfig(req.params.schoolId, { logo_url: storagePath });
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'LOGO_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { logo_url: storagePath },
      });

      return res.json({ success: true, data: { logo_url: await signAsset(storagePath) } });
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

      // The record keeps the file's path in the bucket, never a link: the bucket is private
      // (services/schoolAssets.ts). The answer carries a link that expires, for the screen to show.
      await updateIdentityConfig(req.params.schoolId, { signature_url: storagePath });
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'SIGNATURE_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { signature_url: storagePath },
      });

      return res.json({ success: true, data: { signature_url: await signAsset(storagePath) } });
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

      // The record keeps the file's path in the bucket, never a link: the bucket is private
      // (services/schoolAssets.ts). The answer carries a link that expires, for the screen to show.
      await updateIdentityConfig(req.params.schoolId, { stamp_url: storagePath });
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'STAMP_UPLOAD',
        entity: 'school_settings',
        entityId: req.params.schoolId,
        newValue: { stamp_url: storagePath },
      });

      return res.json({ success: true, data: { stamp_url: await signAsset(storagePath) } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /api/schools/:schoolId/settings/payout ────────────────────────────────

router.get(
  '/:schoolId/settings/payout',
  verifyToken,
  requirePayoutAccess,
  requireFeature('online_payments'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await getSchoolPayoutConfig(req.params.schoolId);
      if (!config) {
        return res.json({ success: true, data: { settlement_status: 'pending' } });
      }
      return res.json({
        success: true,
        data: {
          settlement_status: config.settlement_status,
          bank_code: config.bank_code,
          account_number: maskAccountNumber(config.account_number),
          account_name: config.account_name,
          failure_reason: config.failure_reason,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /api/schools/:schoolId/settings/payout/banks ──────────────────────────

router.get(
  '/:schoolId/settings/payout/banks',
  verifyToken,
  requirePayoutAccess,
  requireFeature('online_payments'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const banks = await listBanks();
      return res.json({ success: true, data: banks });
    } catch (err) {
      if (err instanceof PaystackServiceError) {
        // 424 (not 502/503) deliberately — Railway's edge replaces 5xx response
        // bodies from the app with its own generic error page, which silently
        // destroyed this exact error message before it ever reached the browser.
        return res.status(424).json({ success: false, error: { code: 'PAYSTACK_UNAVAILABLE', message: err.message } });
      }
      return next(err);
    }
  }
);

// ── POST /api/schools/:schoolId/settings/payout/resolve ───────────────────────

router.post(
  '/:schoolId/settings/payout/resolve',
  verifyToken,
  requirePayoutAccess,
  requireFeature('online_payments'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resolvePayoutBankSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      let resolved: { account_name: string } | null;
      try {
        resolved = await resolveBankAccount(parsed.data.bank_code, parsed.data.account_number);
      } catch (err) {
        if (err instanceof PaystackServiceError) {
          // 424 (not 502/503) deliberately — Railway's edge replaces 5xx response
        // bodies from the app with its own generic error page, which silently
        // destroyed this exact error message before it ever reached the browser.
        return res.status(424).json({ success: false, error: { code: 'PAYSTACK_UNAVAILABLE', message: err.message } });
        }
        throw err;
      }
      if (!resolved) {
        return res.status(422).json({ success: false, error: { code: 'ACCOUNT_RESOLVE_FAILED', message: "Couldn't verify this account — check the details and try again." } });
      }
      return res.json({ success: true, data: resolved });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PUT /api/schools/:schoolId/settings/payout ─────────────────────────────────
// Redirecting where a school's fee settlement lands is high-stakes enough that
// it's restricted to principal/super_admin (not bursar — bursar keeps read and
// resolve access above) and gated behind a step-up re-authentication, on top of
// the normal role check.

const MAX_STEP_UP_ATTEMPTS = 5;
const MAX_STEP_UP_IP_ATTEMPTS = 20; // higher threshold to avoid blocking shared NAT addresses
const STEP_UP_LOCK_WINDOW_SECONDS = 15 * 60; // 15 minutes

router.put(
  '/:schoolId/settings/payout',
  verifyToken,
  requireSchoolAccess,
  requireFeature('online_payments'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = savePayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { bank_code, account_number, account_name, current_password } = parsed.data;
      const schoolId = req.params.schoolId;

      // Step-up confirmation: prove the caller knows their own password before
      // this write can proceed, the same way login authenticates them. This is
      // deliberately checked against the caller's real identity (req.user.email)
      // rather than anything client-supplied, so a support-session token (which
      // carries the impersonated school user's identity, not the real operator's)
      // can never satisfy it — impersonation must never be enough to redirect a
      // school's money.
      const callerEmail = req.user!.email;
      if (!callerEmail) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      // Same Redis-backed lockout as POST /api/auth/login (auth.ts) — without
      // it, this password check is an unlimited, unlocked guessing oracle
      // against the caller's real password, reachable at the general 100/min
      // rate limit rather than the login route's 5/min.
      const stepUpEmailKey = `payout_step_up_attempts:${callerEmail.toLowerCase()}`;
      const stepUpIp = clientIp(req) ?? 'unknown';
      const stepUpIpKey = `payout_step_up_attempts_ip:${stepUpIp}`;
      // Best-effort, like the login lockout (SECURITY.md Round 19): a Redis failure is
      // logged as step_up_lockout_unavailable and the password check decides alone.
      if (redis) {
        const r = redis;
        const counts = await bestEffort('step_up_lockout_unavailable', () => Promise.all([r.get(stepUpEmailKey), r.get(stepUpIpKey)]));
        const [emailCount, ipCount] = counts ?? [null, null];
        if (
          (emailCount !== null && parseInt(emailCount, 10) >= MAX_STEP_UP_ATTEMPTS) ||
          (ipCount !== null && parseInt(ipCount, 10) >= MAX_STEP_UP_IP_ATTEMPTS)
        ) {
          return res.status(429).json({
            success: false,
            error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' },
          });
        }
      }

      // Checked through Supabase with the session revoked at once (services/passwordCheck.ts, Round 35).
      if (!(await passwordMatches(callerEmail, current_password))) {
        if (redis) {
          const r = redis;
          await bestEffort('step_up_lockout_unavailable', async () => {
            const [emailAttempts, ipAttempts] = await Promise.all([r.incr(stepUpEmailKey), r.incr(stepUpIpKey)]);
            if (emailAttempts === 1) await r.expire(stepUpEmailKey, STEP_UP_LOCK_WINDOW_SECONDS);
            if (ipAttempts === 1) await r.expire(stepUpIpKey, STEP_UP_LOCK_WINDOW_SECONDS);
          });
        }
        return res.status(401).json({
          success: false,
          error: { code: 'STEP_UP_FAILED', message: 'Current password is incorrect. Re-enter your password to confirm this payout change.' },
        });
      }

      // Never trust the client-confirmed name alone — re-resolve server-side.
      let reResolved: { account_name: string } | null;
      try {
        reResolved = await resolveBankAccount(bank_code, account_number);
      } catch (err) {
        if (err instanceof PaystackServiceError) {
          // 424 (not 502/503) deliberately — Railway's edge replaces 5xx response
        // bodies from the app with its own generic error page, which silently
        // destroyed this exact error message before it ever reached the browser.
        return res.status(424).json({ success: false, error: { code: 'PAYSTACK_UNAVAILABLE', message: err.message } });
        }
        throw err;
      }
      if (!reResolved || reResolved.account_name !== account_name) {
        return res.status(422).json({ success: false, error: { code: 'ACCOUNT_MISMATCH', message: 'Account details could not be re-verified. Please resolve the account again.' } });
      }

      const school = await getSchoolNameAndEmail(schoolId);
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'School not found' } });
      }

      const previousConfig = await getSchoolPayoutConfig(schoolId);
      const subaccount = await createPaystackSubaccount({
        businessName: school.name,
        bankCode: bank_code,
        accountNumber: account_number,
      });

      const now = new Date().toISOString();
      if (!subaccount) {
        // A transient Paystack failure must never destroy a working config: the
        // fees gate requires settlement_status === 'active', so overwriting a
        // live subaccount with a 'failed' row would take the school's fee
        // collection offline platform-wide. Only persist the failed state when
        // there is no active config to protect.
        const hadActiveConfig = previousConfig?.settlement_status === 'active';
        const failureReason = 'Paystack could not create a subaccount for this bank account.';

        if (!hadActiveConfig) {
          const failedConfig: PayoutConfig = {
            bank_code,
            account_number,
            account_name,
            settlement_status: 'failed',
            failure_reason: failureReason,
            updated_at: now,
            updated_by: req.user!.user_id,
          };
          await updateSchoolPayoutConfig(schoolId, failedConfig);
        }

        await logAudit({
          ipAddress: clientIp(req) ?? null,
          supportSession: req.supportSession,
          schoolId,
          userId: req.user!.user_id,
          actionType: 'PAYOUT_CONFIG_CHANGE_FAILED',
          entity: 'schools',
          entityId: schoolId,
          oldValue: previousConfig
            ? { bank_code: previousConfig.bank_code, account_number: maskAccountNumber(previousConfig.account_number), settlement_status: previousConfig.settlement_status }
            : null,
          newValue: {
            bank_code,
            account_number: maskAccountNumber(account_number),
            account_name,
            failure_reason: failureReason,
            existing_config_preserved: hadActiveConfig,
          },
        });

        // 424 (not 502) — see the PAYSTACK_UNAVAILABLE routes above: Railway's
        // edge replaces 5xx bodies from the app with its own generic page.
        return res.status(424).json({
          success: false,
          error: {
            code: 'SUBACCOUNT_CREATE_FAILED',
            message: hadActiveConfig
              ? `${failureReason} Your existing payout account is unchanged and still active.`
              : failureReason,
          },
        });
      }

      const newConfig: PayoutConfig = {
        paystack_subaccount_code: subaccount.subaccount_code,
        bank_code,
        account_number,
        account_name,
        settlement_status: 'active',
        updated_at: now,
        updated_by: req.user!.user_id,
      };
      await updateSchoolPayoutConfig(schoolId, newConfig);

      await logAudit({
        ipAddress: clientIp(req) ?? null,
        supportSession: req.supportSession,
        schoolId,
        userId: req.user!.user_id,
        actionType: 'PAYOUT_CONFIG_CHANGE',
        entity: 'schools',
        entityId: schoolId,
        oldValue: previousConfig
          ? { bank_code: previousConfig.bank_code, account_number: maskAccountNumber(previousConfig.account_number) }
          : null,
        newValue: { bank_code, account_number: maskAccountNumber(account_number), account_name },
      });

      await sendPayoutChangeAlerts(schoolId, req.user!.email ?? 'unknown', maskAccountNumber(account_number) ?? '', bank_code, req.supportSession);

      return res.json({ success: true, data: { message: 'Payout account saved', settlement_status: 'active' } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
