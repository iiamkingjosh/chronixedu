import { Router, Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { verifyToken, requireRole } from '../middleware/auth';
import pool from '../db/client';
import { supabaseAdmin } from '../supabaseClient';
import { sendEmail, isEmailConfigured } from '../services/emailService';
import { insertSchoolSettings, updateIdentityConfig, updateAcademicConfig } from '../db/queries/schools';
import { cache, schoolCacheKey } from '../services/cacheService';
import { NIGERIAN_DEFAULTS } from '../services/schoolService';
import { getCronStatus } from '../services/cronTracker';
import { getRecentErrorCount } from '../services/platformAnalyticsService';
import { redis } from '../middleware/rateLimit';
// Imported for their module-level registerCron() side effects, so GET /health/crons
// reflects every scheduled job even before the crons have started running.
import '../services/analyticsService';
import '../services/feeReminderService';
import '../services/subscriptionService';

const router = Router();

const guard = [verifyToken, requireRole('super_admin')];

// Only the root Chronix Technology account can suspend, reactivate, or delete other
// platform admins. This stops any other super_admin from acting against a peer —
// e.g. during a dispute between platform admins — since none of them can touch
// each other's access, only the company-owned root account can.
if (!process.env.ROOT_ADMIN_EMAIL) throw new Error('ROOT_ADMIN_EMAIL is not set');
const ROOT_ADMIN_EMAIL = process.env.ROOT_ADMIN_EMAIL.toLowerCase();

function requireRootAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.email?.toLowerCase() !== ROOT_ADMIN_EMAIL) {
    return res.status(403).json({
      success: false,
      error: { code: 'ROOT_ADMIN_REQUIRED', message: 'Only the root platform admin can perform this action' },
    });
  }
  return next();
}

const rootGuard = [...guard, requireRootAdmin];

// ── Schemas ────────────────────────────────────────────────────────────────────

const createSupportSessionSchema = z.object({
  school_id: z.string().uuid(),
  user_id: z.string().uuid(),
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

const auditLogsQuerySchema = z.object({
  school_id: z.string().uuid().optional(),
  action_type: z.string().optional(),
  support_session_id: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
});

const listSchoolsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  search: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  plan: z.enum(['basic', 'professional', 'enterprise', 'trial']).optional(),
});

const schoolActionSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
});

const wipeSchoolDataSchema = z.object({
  confirmation_token: z.string(),
});

const SCHOOLS_PAGE_SIZE = 25;
const SUBSCRIPTIONS_PAGE_SIZE = 25;

const listSubscriptionsQuerySchema = z.object({
  status: z.string().optional(),
  plan: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
});

const createSubscriptionSchema = z
  .object({
    school_id: z.string().uuid(),
    plan: z.enum(['basic', 'professional', 'enterprise', 'trial']),
    billing_cycle: z.enum(['monthly', 'annual']),
    amount_naira: z.number().positive(),
    trial_ends_at: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.plan === 'trial' && !data.trial_ends_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'trial_ends_at is required for trial plan',
        path: ['trial_ends_at'],
      });
    }
  });

const updateSubscriptionSchema = z
  .object({
    plan: z.enum(['basic', 'professional', 'enterprise', 'trial']).optional(),
    subscription_status: z.enum(['active', 'suspended', 'cancelled', 'trial']).optional(),
    billing_cycle: z.enum(['monthly', 'annual']).optional(),
    amount_naira: z.number().positive().optional(),
    next_billing_date: z.string().optional(),
    trial_ends_at: z.string().optional(),
  })
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const extendTrialSchema = z.object({
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
});

const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  reference: z.string().min(3),
  payment_date: z.string(),
  notes: z.string().optional(),
});

// ── Onboarding wizard schemas ───────────────────────────────────────────────

const startOnboardingSchema = z.object({
  school_name: z.string().min(3),
  school_email: z.string().email(),
});

const onboardingStep1Schema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  phone: z.string().min(1),
});

const onboardingStep2Schema = z
  .object({
    motto: z.string().min(1).optional(),
    primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
    admission_prefix: z.string().min(1).optional(),
  })
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const onboardingTermSchema = z.object({
  name: z.string().min(1),
  start_date: z.string(),
  end_date: z.string(),
});

const onboardingStep3Schema = z
  .object({
    session_name: z.string().min(1),
    terms: z.array(onboardingTermSchema).length(3, 'Exactly 3 terms are required'),
  })
  .superRefine((data, ctx) => {
    data.terms.forEach((term, idx) => {
      const start = new Date(term.start_date);
      const end = new Date(term.end_date);
      if (isNaN(start.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Term ${idx + 1}: invalid start_date`, path: ['terms', idx, 'start_date'] });
      }
      if (isNaN(end.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Term ${idx + 1}: invalid end_date`, path: ['terms', idx, 'end_date'] });
      }
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Term ${idx + 1}: end_date must be after start_date`, path: ['terms', idx, 'end_date'] });
      }
    });
  });

const onboardingGradeSchema = z.object({
  label: z.string().min(1),
  min: z.number().min(0).max(100),
  max: z.number().min(0).max(100),
  remark: z.string(),
});

const onboardingStep4Schema = z.object({
  grades: z.array(onboardingGradeSchema).min(1),
});

const onboardingComponentSchema = z.object({
  name: z.string().min(1),
  max_score: z.number().positive(),
  weight_percent: z.number().positive(),
});

const onboardingStep5Schema = z.object({
  components: z.array(onboardingComponentSchema).min(1),
});

const onboardingStep6Schema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
});

const completeOnboardingSchema = z.object({
  accepted_legal_terms: z.literal(true),
});

const ONBOARDING_TOTAL_STEPS = 6;

// ── Announcement schemas ─────────────────────────────────────────────────────

const announcementTypeEnum = z.enum(['info', 'warning', 'critical', 'maintenance']);
const announcementPlanEnum = z.enum(['basic', 'professional', 'enterprise', 'trial']);

function validateAnnouncementDates(data: { scheduled_at?: string; expires_at?: string }, ctx: z.RefinementCtx): void {
  if (data.scheduled_at !== undefined) {
    const scheduled = new Date(data.scheduled_at);
    if (isNaN(scheduled.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scheduled_at must be a valid ISO date', path: ['scheduled_at'] });
    } else if (scheduled <= new Date()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scheduled_at must be in the future', path: ['scheduled_at'] });
    }
  }
  if (data.expires_at !== undefined && isNaN(new Date(data.expires_at).getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expires_at must be a valid ISO date', path: ['expires_at'] });
  }
}

const createAnnouncementSchema = z
  .object({
    title: z.string().min(3),
    body: z.string().min(10),
    type: announcementTypeEnum,
    target_plans: z.array(announcementPlanEnum).min(1),
    scheduled_at: z.string().optional(),
    expires_at: z.string().optional(),
  })
  .superRefine(validateAnnouncementDates);

const updateAnnouncementSchema = z
  .object({
    title: z.string().min(3).optional(),
    body: z.string().min(10).optional(),
    type: announcementTypeEnum.optional(),
    target_plans: z.array(announcementPlanEnum).min(1).optional(),
    scheduled_at: z.string().optional(),
    expires_at: z.string().optional(),
  })
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' })
  .superRefine(validateAnnouncementDates);

const listAnnouncementsQuerySchema = z.object({
  status: z.enum(['scheduled', 'published', 'expired', 'all']).optional().default('all'),
});

/** Returns the expected hours between runs of a standard cron expression ("min hour day month dow"). */
function parseExpectedIntervalHours(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  const hour = parts[1];
  const dayOfWeek = parts[4];
  if (dayOfWeek !== '*') return 168; // weekly
  if (hour !== '*') return 24; // daily
  return 1; // hourly
}

// Escapes a value for inclusion in a CSV cell.
function csvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ── POST /support-sessions ──────────────────────────────────────────────────────
// Starts an impersonation session against a user in another school.

router.post(
  '/support-sessions',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSupportSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { school_id, user_id, reason } = parsed.data;

      const targetResult = await pool.query<{ id: string; school_id: string; role: string; email: string; title: string | null }>(
        `SELECT id, school_id, role, email, title FROM users WHERE id = $1 AND school_id = $2 AND is_active = true`,
        [user_id, school_id]
      );
      const target = targetResult.rows[0];
      if (!target) {
        return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found in target school' } });
      }
      if (target.role === 'super_admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot impersonate another super admin' } });
      }

      const sessionResult = await pool.query<{ id: string }>(
        `INSERT INTO support_sessions (platform_admin_id, school_id, impersonated_user_id, reason, actions_taken)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [req.user!.user_id, school_id, user_id, reason, '[]']
      );
      const sessionId = sessionResult.rows[0].id;

      const expiresIn = process.env.SUPPORT_SESSION_MAX_DURATION_HOURS
        ? `${process.env.SUPPORT_SESSION_MAX_DURATION_HOURS}h`
        : '30m';

      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) throw new Error('JWT_SECRET is not set');

      const scopedToken = jwt.sign(
        {
          // AuthUser-compatible fields: school-scoped routes call verifyToken
          // again after detectSupportSession, which re-decodes this token and
          // overwrites req.user — so the impersonated identity must already be
          // present here for those routes to authorize correctly.
          user_id: target.id,
          school_id: target.school_id,
          role: target.role,
          email: target.email,
          title: target.title,
          support_session_id: sessionId,
          is_support_session: true,
          real_admin_id: req.user!.user_id,
          impersonated_user_id: target.id,
          impersonated_school_id: target.school_id,
          impersonated_role: target.role,
          impersonated_email: target.email,
          impersonated_title: target.title,
        },
        jwtSecret,
        { expiresIn: expiresIn as SignOptions['expiresIn'] }
      );

      // Store scoped token in Redis so it can be revoked when the session ends.
      const tokenTtlSeconds = process.env.SUPPORT_SESSION_MAX_DURATION_HOURS
        ? parseInt(process.env.SUPPORT_SESSION_MAX_DURATION_HOURS, 10) * 3600
        : 30 * 60;
      if (redis) {
        await redis.set(`support_session_token:${sessionId}`, scopedToken, 'EX', tokenTtlSeconds + 60);
      }

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, target_user_id, metadata, ip_address, support_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user!.user_id, 'IMPERSONATION_START', school_id, user_id, JSON.stringify({ reason, target_role: target.role }), req.ip, sessionId]
      );

      return res.json({ success: true, data: { session_id: sessionId, scoped_token: scopedToken } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /support-sessions/:id/end ───────────────────────────────────────────────
// Ends an impersonation session started by the current super admin.

router.patch(
  '/support-sessions/:id/end',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query<{ id: string; started_at: string; ended_at: string }>(
        `UPDATE support_sessions
         SET ended_at = NOW()
         WHERE id = $1 AND platform_admin_id = $2 AND ended_at IS NULL
         RETURNING id, started_at, ended_at`,
        [req.params.id, req.user!.user_id]
      );
      const session = result.rows[0];
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found or already ended' } });
      }

      const durationMinutes = Math.round(
        (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000
      );

      // Revoke the scoped token so it cannot be used after the session ends.
      if (redis) {
        const storedToken = await redis.get(`support_session_token:${session.id}`);
        if (storedToken) {
          await redis.set(`blacklisted_token:${storedToken}`, '1', 'EX', 30 * 60);
          await redis.del(`support_session_token:${session.id}`);
        }
      }

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, support_session_id, metadata)
         VALUES ($1, $2, $3, $4)`,
        [req.user!.user_id, 'IMPERSONATION_END', session.id, JSON.stringify({ duration_minutes: durationMinutes })]
      );

      return res.json({ success: true, data: { session_id: session.id, duration_minutes: durationMinutes } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /support-sessions ─────────────────────────────────────────────────────────
// Lists recent impersonation sessions across all schools.

router.get(
  '/support-sessions',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT
           ss.id,
           ss.reason,
           ss.started_at,
           ss.ended_at,
           admin.email AS admin_email,
           target.email AS impersonated_email,
           target.role AS impersonated_role,
           s.name AS school_name,
           CASE WHEN ss.ended_at IS NULL THEN 'active' ELSE 'ended' END AS status,
           ROUND(EXTRACT(EPOCH FROM (COALESCE(ss.ended_at, NOW()) - ss.started_at)) / 60)::int AS duration_minutes
         FROM support_sessions ss
         JOIN users admin ON admin.id = ss.platform_admin_id
         JOIN users target ON target.id = ss.impersonated_user_id
         JOIN schools s ON s.id = ss.school_id
         ORDER BY ss.started_at DESC
         LIMIT 50`
      );
      return res.json({ success: true, data: result.rows });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /audit-logs ────────────────────────────────────────────────────────────────
// Lists platform-level audit log entries, optionally filtered.

router.get(
  '/audit-logs',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = auditLogsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { school_id, action_type, support_session_id, from, to, page } = parsed.data;

      const params: unknown[] = [];
      const where: string[] = [];

      if (school_id) { params.push(school_id); where.push(`pal.target_school_id = $${params.length}`); }
      if (action_type) { params.push(action_type); where.push(`pal.action_type = $${params.length}`); }
      if (support_session_id) { params.push(support_session_id); where.push(`pal.support_session_id = $${params.length}`); }
      if (from) { params.push(from); where.push(`pal.created_at >= $${params.length}`); }
      if (to) { params.push(to); where.push(`pal.created_at <= $${params.length}`); }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      params.push(50);
      const limitParam = params.length;
      params.push((page - 1) * 50);
      const offsetParam = params.length;

      const result = await pool.query(
        `SELECT
           pal.id,
           pal.action_type,
           pal.target_school_id,
           pal.target_user_id,
           pal.metadata,
           pal.ip_address,
           pal.support_session_id,
           pal.created_at,
           admin.email AS admin_email,
           s.name AS school_name
         FROM platform_audit_logs pal
         JOIN users admin ON admin.id = pal.platform_admin_id
         LEFT JOIN schools s ON s.id = pal.target_school_id
         ${whereClause}
         ORDER BY pal.created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      );

      return res.json({ success: true, data: result.rows });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /schools ──────────────────────────────────────────────────────────────
// Paginated list of all schools on the platform, with subscription and activity data.

router.get(
  '/schools',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listSchoolsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { page, search, status, plan } = parsed.data;

      const params: unknown[] = [];
      const where: string[] = [];

      if (search) { params.push(`%${search}%`); where.push(`schools.name ILIKE $${params.length}`); }
      if (status) { params.push(status === 'active'); where.push(`schools.is_active = $${params.length}`); }
      if (plan) { params.push(plan); where.push(`platform_subscriptions.plan = $${params.length}`); }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)
         FROM schools
         LEFT JOIN platform_subscriptions ON platform_subscriptions.school_id = schools.id
         ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      params.push(SCHOOLS_PAGE_SIZE);
      const limitParam = params.length;
      params.push((page - 1) * SCHOOLS_PAGE_SIZE);
      const offsetParam = params.length;

      const result = await pool.query(
        `SELECT
           schools.id,
           schools.name,
           schools.slug,
           schools.is_active,
           platform_subscriptions.plan,
           platform_subscriptions.subscription_status,
           platform_subscriptions.amount_naira,
           platform_subscriptions.next_billing_date,
           (SELECT COUNT(*) FROM students WHERE students.school_id = schools.id) AS student_count,
           (SELECT MAX(created_at) FROM audit_logs WHERE audit_logs.school_id = schools.id) AS last_activity,
           schools.created_at
         FROM schools
         LEFT JOIN platform_subscriptions ON platform_subscriptions.school_id = schools.id
         ${whereClause}
         ORDER BY schools.created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      );

      return res.json({ success: true, data: { schools: result.rows, total, page, limit: SCHOOLS_PAGE_SIZE } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /schools/:schoolId ───────────────────────────────────────────────────────
// Full detail view of a single school: profile, settings, subscription, user counts, recent activity.

router.get(
  '/schools/:schoolId',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schoolResult = await pool.query(`SELECT * FROM schools WHERE id = $1`, [req.params.schoolId]);
      const school = schoolResult.rows[0];
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }

      const settingsResult = await pool.query(`SELECT * FROM school_settings WHERE school_id = $1`, [req.params.schoolId]);
      const subscriptionResult = await pool.query(`SELECT * FROM platform_subscriptions WHERE school_id = $1`, [req.params.schoolId]);
      const userCountsResult = await pool.query(
        `SELECT role, COUNT(*) FROM users WHERE school_id = $1 GROUP BY role`,
        [req.params.schoolId]
      );
      const recentActivityResult = await pool.query(
        `SELECT * FROM audit_logs WHERE school_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [req.params.schoolId]
      );

      return res.json({
        success: true,
        data: {
          school,
          settings: settingsResult.rows[0] ?? null,
          subscription: subscriptionResult.rows[0] ?? null,
          user_counts: userCountsResult.rows,
          recent_activity: recentActivityResult.rows,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /schools/:schoolId/suspend ────────────────────────────────────────────
// Suspends a school, blocking access for all of its users.

router.patch(
  '/schools/:schoolId/suspend',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schoolActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { reason } = parsed.data;

      const schoolResult = await pool.query<{ id: string; is_active: boolean }>(
        `SELECT id, is_active FROM schools WHERE id = $1`,
        [req.params.schoolId]
      );
      const school = schoolResult.rows[0];
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }
      if (!school.is_active) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_SUSPENDED', message: 'School is already suspended' } });
      }

      await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [req.params.schoolId]);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SCHOOL_SUSPENDED', req.params.schoolId, JSON.stringify({ reason, suspended_by: req.user!.email }), req.ip]
      );

      return res.json({ success: true, data: { school_id: req.params.schoolId, is_active: false, reason } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /schools/:schoolId/reactivate ─────────────────────────────────────────
// Reactivates a previously suspended school.

router.patch(
  '/schools/:schoolId/reactivate',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schoolActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { reason } = parsed.data;

      const schoolResult = await pool.query<{ id: string; is_active: boolean }>(
        `SELECT id, is_active FROM schools WHERE id = $1`,
        [req.params.schoolId]
      );
      const school = schoolResult.rows[0];
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }
      if (school.is_active) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_ACTIVE', message: 'School is already active' } });
      }

      await pool.query(`UPDATE schools SET is_active = true WHERE id = $1`, [req.params.schoolId]);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SCHOOL_REACTIVATED', req.params.schoolId, JSON.stringify({ reason, reactivated_by: req.user!.email }), req.ip]
      );

      return res.json({ success: true, data: { school_id: req.params.schoolId, is_active: true, reason } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /schools/:schoolId/export ───────────────────────────────────────────────
// Downloads a CSV of every student enrolled at the school.

router.get(
  '/schools/:schoolId/export',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schoolResult = await pool.query(`SELECT id FROM schools WHERE id = $1`, [req.params.schoolId]);
      if (!schoolResult.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }

      const result = await pool.query(
        `SELECT
           s.admission_no,
           u.first_name || ' ' || u.last_name AS full_name,
           s.gender,
           s.dob,
           c.name AS current_class,
           u.is_active
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN student_classes sc ON sc.student_id = s.id
         LEFT JOIN classes c ON c.id = sc.class_id
         WHERE s.school_id = $1
         ORDER BY u.last_name, u.first_name`,
        [req.params.schoolId]
      );

      const header = 'Admission No,Full Name,Gender,Date of Birth,Current Class,Active';
      const lines = result.rows.map(row =>
        [row.admission_no, row.full_name, row.gender, row.dob, row.current_class, row.is_active]
          .map(csvCell)
          .join(',')
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="school-${req.params.schoolId}-students.csv"`);
      return res.send([header, ...lines].join('\n'));
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /schools/:schoolId/data ──────────────────────────────────────────────
// DANGER: permanently wipes a school's student, score, and result data.
// The school record, settings, users, and subscription are preserved.

router.delete(
  '/schools/:schoolId/data',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = wipeSchoolDataSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const schoolResult = await pool.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM schools WHERE id = $1`,
        [req.params.schoolId]
      );
      const school = schoolResult.rows[0];
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }

      if (parsed.data.confirmation_token !== school.slug) {
        return res.status(400).json({ error: true, code: 'CONFIRMATION_FAILED', message: 'Confirmation token does not match school slug' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM scores WHERE school_id = $1`, [req.params.schoolId]);
        await client.query(`DELETE FROM result_status WHERE school_id = $1`, [req.params.schoolId]);
        await client.query(`DELETE FROM report_cards WHERE school_id = $1`, [req.params.schoolId]);
        await client.query(
          `DELETE FROM student_classes WHERE student_id IN (SELECT id FROM students WHERE school_id = $1)`,
          [req.params.schoolId]
        );
        await client.query(
          `DELETE FROM parent_students WHERE student_id IN (SELECT id FROM students WHERE school_id = $1)`,
          [req.params.schoolId]
        );
        await client.query(`DELETE FROM students WHERE school_id = $1`, [req.params.schoolId]);

        await client.query(
          `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user!.user_id, 'SCHOOL_DATA_WIPED', req.params.schoolId, JSON.stringify({ wiped_by: req.user!.email, school_slug: school.slug }), req.ip]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return res.json({ success: true, data: { message: 'School data wiped. School record and settings preserved.', school_id: req.params.schoolId } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /subscriptions ───────────────────────────────────────────────────────
// Paginated list of all platform subscriptions, with billing summary.

router.get(
  '/subscriptions',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listSubscriptionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { status, plan, page } = parsed.data;

      const params: unknown[] = [];
      const where: string[] = [];

      if (status) { params.push(status); where.push(`ps.subscription_status = $${params.length}`); }
      if (plan) { params.push(plan); where.push(`ps.plan = $${params.length}`); }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)
         FROM platform_subscriptions ps
         JOIN schools s ON s.id = ps.school_id
         ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      params.push(SUBSCRIPTIONS_PAGE_SIZE);
      const limitParam = params.length;
      params.push((page - 1) * SUBSCRIPTIONS_PAGE_SIZE);
      const offsetParam = params.length;

      const result = await pool.query(
        `SELECT
           ps.id,
           ps.school_id,
           s.name AS school_name,
           s.slug AS school_slug,
           ps.plan,
           ps.subscription_status,
           ps.amount_naira,
           ps.billing_cycle,
           ps.next_billing_date,
           ps.trial_ends_at,
           ps.created_at,
           EXTRACT(DAY FROM (ps.next_billing_date - NOW()))::integer AS days_until_billing
         FROM platform_subscriptions ps
         JOIN schools s ON s.id = ps.school_id
         ${whereClause}
         ORDER BY ps.created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      );

      const summaryResult = await pool.query<{
        total_mrr_naira: string;
        total_annual_naira: string;
        active_count: string;
        trial_count: string;
        suspended_count: string;
      }>(
        `SELECT
           COALESCE(SUM(amount_naira) FILTER (WHERE subscription_status = 'active' AND billing_cycle = 'monthly'), 0) AS total_mrr_naira,
           COALESCE(SUM(amount_naira) FILTER (WHERE subscription_status = 'active' AND billing_cycle = 'annual'), 0) AS total_annual_naira,
           COUNT(*) FILTER (WHERE subscription_status = 'active') AS active_count,
           COUNT(*) FILTER (WHERE subscription_status = 'trial') AS trial_count,
           COUNT(*) FILTER (WHERE subscription_status = 'suspended') AS suspended_count
         FROM platform_subscriptions`
      );
      const summaryRow = summaryResult.rows[0];
      const summary = {
        total_mrr_naira: Number(summaryRow.total_mrr_naira),
        total_annual_naira: Number(summaryRow.total_annual_naira),
        active_count: parseInt(summaryRow.active_count, 10),
        trial_count: parseInt(summaryRow.trial_count, 10),
        suspended_count: parseInt(summaryRow.suspended_count, 10),
      };

      return res.json({ success: true, data: { subscriptions: result.rows, summary, total, page, limit: SUBSCRIPTIONS_PAGE_SIZE } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /subscriptions/mrr ──────────────────────────────────────────────────
// Snapshot of current MRR broken down by plan. Registered before
// /subscriptions/:id routes so 'mrr' is never matched as an :id.

router.get(
  '/subscriptions/mrr',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query<{ plan: string; billing_cycle: string; total_amount: string; count: string }>(
        `SELECT plan, billing_cycle, COALESCE(SUM(amount_naira), 0) AS total_amount, COUNT(*) AS count
         FROM platform_subscriptions
         WHERE subscription_status = 'active'
         GROUP BY plan, billing_cycle`
      );

      const PLANS = ['basic', 'professional', 'enterprise'] as const;
      const byPlan = new Map<string, { mrr: number; count: number }>(PLANS.map(plan => [plan, { mrr: 0, count: 0 }]));

      for (const row of result.rows) {
        const entry = byPlan.get(row.plan);
        if (!entry) continue;
        const amount = Number(row.total_amount);
        const mrr = row.billing_cycle === 'annual' ? amount / 12 : amount;
        entry.mrr += mrr;
        entry.count += parseInt(row.count, 10);
      }

      const by_plan = PLANS.map(plan => ({ plan, mrr: byPlan.get(plan)!.mrr, count: byPlan.get(plan)!.count }));
      const total_mrr = by_plan.reduce((sum, p) => sum + p.mrr, 0);

      return res.json({ success: true, data: { total_mrr, by_plan, currency: 'NGN' } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /subscriptions ─────────────────────────────────────────────────────
// Creates a subscription for a school that doesn't yet have one.

router.post(
  '/subscriptions',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { school_id, plan, billing_cycle, amount_naira, trial_ends_at } = parsed.data;

      const schoolResult = await pool.query(`SELECT id FROM schools WHERE id = $1`, [school_id]);
      if (!schoolResult.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }

      const existing = await pool.query(`SELECT id FROM platform_subscriptions WHERE school_id = $1`, [school_id]);
      if (existing.rows[0]) {
        return res.status(409).json({ success: false, error: { code: 'SUBSCRIPTION_EXISTS', message: 'School already has a subscription. Use PATCH to update.' } });
      }

      const subscriptionStatus = plan === 'trial' ? 'trial' : 'active';

      const result = await pool.query(
        `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, amount_naira, trial_ends_at, subscription_status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [school_id, plan, billing_cycle, amount_naira, trial_ends_at ?? null, subscriptionStatus]
      );
      const subscription = result.rows[0];

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SUBSCRIPTION_CREATED', school_id, JSON.stringify({ plan, billing_cycle, amount_naira }), req.ip]
      );

      return res.status(201).json({ success: true, data: subscription });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /subscriptions/:id ────────────────────────────────────────────────
// Updates one or more fields of an existing subscription.

router.patch(
  '/subscriptions/:id',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const existingResult = await pool.query(`SELECT * FROM platform_subscriptions WHERE id = $1`, [req.params.id]);
      const existing = existingResult.rows[0];
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' } });
      }

      const params: unknown[] = [];
      const fields: string[] = [];
      for (const [key, value] of Object.entries(parsed.data)) {
        params.push(value);
        fields.push(`${key} = $${params.length}`);
      }
      fields.push(`updated_at = NOW()`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE platform_subscriptions SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      const updated = result.rows[0];

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SUBSCRIPTION_UPDATED', existing.school_id, JSON.stringify({ changes: req.body, previous_plan: existing.plan }), req.ip]
      );

      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /subscriptions/:id/extend-trial ────────────────────────────────────
// Pushes a trial subscription's expiry date out by 7, 14, or 30 days.

router.post(
  '/subscriptions/:id/extend-trial',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = extendTrialSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { days } = parsed.data;

      const existingResult = await pool.query<{ id: string; school_id: string; subscription_status: string }>(
        `SELECT id, school_id, subscription_status FROM platform_subscriptions WHERE id = $1`,
        [req.params.id]
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' } });
      }
      if (existing.subscription_status !== 'trial') {
        return res.status(400).json({ success: false, error: { code: 'NOT_A_TRIAL', message: 'Can only extend trial subscriptions' } });
      }

      const result = await pool.query<{ trial_ends_at: string }>(
        `UPDATE platform_subscriptions
         SET trial_ends_at = trial_ends_at + (INTERVAL '1 day' * $2::integer), updated_at = NOW()
         WHERE id = $1
         RETURNING trial_ends_at`,
        [req.params.id, days]
      );
      const newTrialEndsAt = result.rows[0].trial_ends_at;

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'TRIAL_EXTENDED', existing.school_id, JSON.stringify({ days_added: days, new_trial_ends_at: newTrialEndsAt }), req.ip]
      );

      return res.json({ success: true, data: { subscription_id: req.params.id, days_added: days, new_trial_ends_at: newTrialEndsAt } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /subscriptions/:id/record-payment ──────────────────────────────────
// Records a manually-received payment (e.g. bank transfer) against a subscription.

router.post(
  '/subscriptions/:id/record-payment',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = recordPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { amount, reference, payment_date, notes } = parsed.data;

      const result = await pool.query<{ id: string; school_id: string; plan: string }>(
        `SELECT ps.id, ps.school_id, ps.plan
         FROM platform_subscriptions ps
         JOIN schools s ON s.id = ps.school_id
         WHERE ps.id = $1`,
        [req.params.id]
      );
      const subscription = result.rows[0];
      if (!subscription) {
        return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' } });
      }

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.user!.user_id,
          'MANUAL_PAYMENT_RECORDED',
          subscription.school_id,
          JSON.stringify({ amount, reference, payment_date, notes: notes ?? null, plan: subscription.plan, recorded_by: req.user!.email }),
          req.ip,
        ]
      );

      return res.json({
        success: true,
        data: { subscription_id: req.params.id, school_id: subscription.school_id, amount_recorded: amount, reference, payment_date },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── Onboarding wizard helpers ───────────────────────────────────────────────

/** Generates a URL-safe slug from a school name with a random 6-char suffix for uniqueness. */
function generateOnboardingSlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `${base}-${randomUUID().slice(0, 6)}`;
}

/** Generates a random 12-character password mixing upper/lowercase letters, digits, and symbols. */
function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;
  const pick = (chars: string) => chars[Math.floor(Math.random() * chars.length)];

  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < 12; i++) chars.push(pick(all));

  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Ensures a school_settings row exists for the school, inserting Nigerian defaults if missing. */
async function ensureSchoolSettings(schoolId: string, schoolName: string): Promise<void> {
  const existing = await pool.query(`SELECT id FROM school_settings WHERE school_id = $1`, [schoolId]);
  if (existing.rows[0]) return;

  const identityConfig: Record<string, unknown> = {
    name: schoolName,
    motto: '',
    logo_url: null,
    stamp_url: null,
    primary_colour: null,
    secondary_colour: null,
  };
  await insertSchoolSettings(schoolId, identityConfig, NIGERIAN_DEFAULTS as unknown as Record<string, unknown>);
}

/** Returns null if the grading scale is valid, otherwise a specific error message. */
function validateOnboardingGrades(grades: { label: string; min: number; max: number; remark: string }[]): string | null {
  for (const grade of grades) {
    if (grade.min >= grade.max) {
      return `Grade ${grade.label}: min (${grade.min}) must be less than max (${grade.max})`;
    }
  }

  const sorted = [...grades].sort((a, b) => a.min - b.min);

  if (sorted[0].min !== 0) {
    return `Grading scale must start at 0. Lowest min is ${sorted[0].min}`;
  }
  if (sorted[sorted.length - 1].max !== 100) {
    return `Grading scale must end at 100. Highest max is ${sorted[sorted.length - 1].max}`;
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min !== sorted[i - 1].max + 1) {
      return `Gap in grading scale between ${sorted[i - 1].label} (max ${sorted[i - 1].max}) and ${sorted[i].label} (min ${sorted[i].min})`;
    }
  }
  return null;
}

// ── GET /onboarding ──────────────────────────────────────────────────────────
// Lists all onboarding sessions with their associated school name.

router.get(
  '/onboarding',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT os.id, os.status, os.steps_completed, os.created_at, os.completed_at,
                os.school_id, s.name AS school_name, os.created_by
         FROM onboarding_sessions os
         LEFT JOIN schools s ON s.id = os.school_id
         ORDER BY os.created_at DESC
         LIMIT 50`
      );
      return res.json({ success: true, data: result.rows });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /onboarding ─────────────────────────────────────────────────────────
// Starts a new onboarding session, creating an inactive placeholder school.

router.post(
  '/onboarding',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = startOnboardingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { school_name, school_email } = parsed.data;

      const existing = await pool.query(`SELECT id FROM schools WHERE email = $1`, [school_email]);
      if (existing.rows[0]) {
        return res.status(409).json({ success: false, error: { code: 'SCHOOL_EMAIL_EXISTS', message: 'A school with this email already exists' } });
      }

      const slug = generateOnboardingSlug(school_name);

      const schoolResult = await pool.query<{ id: string; slug: string }>(
        `INSERT INTO schools (name, slug, email, is_active, subscription_tier)
         VALUES ($1, $2, $3, FALSE, 'trial')
         RETURNING id, slug`,
        [school_name, slug, school_email]
      );
      const school = schoolResult.rows[0];

      const sessionResult = await pool.query<{ id: string }>(
        `INSERT INTO onboarding_sessions (school_id, created_by, status, steps_completed)
         VALUES ($1, $2, 'in_progress', '{}'::jsonb)
         RETURNING id`,
        [school.id, req.user!.user_id]
      );
      const session = sessionResult.rows[0];

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'ONBOARDING_STARTED', school.id, JSON.stringify({ school_name, school_email }), req.ip]
      );

      return res.status(201).json({ success: true, data: { session_id: session.id, school_id: school.id, school_slug: school.slug } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /onboarding/:sessionId ──────────────────────────────────────────────
// Returns the current progress of an onboarding session.

router.get(
  '/onboarding/:sessionId',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionResult = await pool.query(`SELECT * FROM onboarding_sessions WHERE id = $1`, [req.params.sessionId]);
      const session = sessionResult.rows[0];
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Onboarding session not found' } });
      }

      const schoolResult = await pool.query(`SELECT * FROM schools WHERE id = $1`, [session.school_id]);
      const school = schoolResult.rows[0] ?? null;

      const completedSteps = Object.keys(session.steps_completed ?? {});
      let nextStep: number | null = null;
      for (let step = 1; step <= ONBOARDING_TOTAL_STEPS; step++) {
        if (!completedSteps.includes(String(step))) {
          nextStep = step;
          break;
        }
      }

      return res.json({ success: true, data: { session, school, completed_steps: completedSteps, next_step: nextStep } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /onboarding/:sessionId/step/:stepNumber ────────────────────────────
// Saves progress for one step (1-7) of the onboarding wizard.

router.patch(
  '/onboarding/:sessionId/step/:stepNumber',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stepNumber = Number(req.params.stepNumber);
      if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > ONBOARDING_TOTAL_STEPS) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_STEP', message: 'Step number must be between 1 and 6' } });
      }

      const sessionResult = await pool.query(`SELECT * FROM onboarding_sessions WHERE id = $1`, [req.params.sessionId]);
      const session = sessionResult.rows[0];
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Onboarding session not found' } });
      }
      if (session.status !== 'in_progress') {
        return res.status(409).json({ success: false, error: { code: 'SESSION_NOT_IN_PROGRESS', message: `Onboarding session is already ${session.status}` } });
      }

      const schoolResult = await pool.query(`SELECT * FROM schools WHERE id = $1`, [session.school_id]);
      const school = schoolResult.rows[0];

      let stepData: Record<string, unknown> = {};
      let extraResponseData: Record<string, unknown> = {};

      switch (stepNumber) {
        case 1: {
          const parsed = onboardingStep1Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { name, address, phone } = parsed.data;
          await pool.query(`UPDATE schools SET name = $1, address = $2, phone = $3 WHERE id = $4`, [name, address, phone, school.id]);
          stepData = { name, address, phone };
          break;
        }

        case 2: {
          const parsed = onboardingStep2Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { motto, primary_colour, admission_prefix } = parsed.data;

          await ensureSchoolSettings(school.id, school.name);

          const identityPatch: Record<string, unknown> = {};
          if (motto !== undefined) identityPatch.motto = motto;
          if (primary_colour !== undefined) identityPatch.primary_colour = primary_colour;
          if (admission_prefix !== undefined) identityPatch.admission_prefix = admission_prefix;
          await updateIdentityConfig(school.id, identityPatch);

          stepData = { motto, primary_colour, admission_prefix };
          break;
        }

        case 3: {
          const parsed = onboardingStep3Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { session_name, terms } = parsed.data;

          const sessionRowResult = await pool.query<{ id: string }>(
            `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
             VALUES ($1, $2, $3, $4, TRUE)
             RETURNING id`,
            [school.id, session_name, terms[0].start_date, terms[terms.length - 1].end_date]
          );
          const academicSessionId = sessionRowResult.rows[0].id;

          for (let i = 0; i < terms.length; i++) {
            const term = terms[i];
            await pool.query(
              `INSERT INTO terms (session_id, school_id, name, start_date, end_date, is_current)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [academicSessionId, school.id, term.name, term.start_date, term.end_date, i === 0]
            );
          }

          stepData = { session_name, terms };
          break;
        }

        case 4: {
          const parsed = onboardingStep4Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { grades } = parsed.data;

          const gradeError = validateOnboardingGrades(grades);
          if (gradeError) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_GRADING_SCALE', message: gradeError } });
          }

          await ensureSchoolSettings(school.id, school.name);
          await updateAcademicConfig(school.id, { grading_scale: grades });

          stepData = { grades };
          break;
        }

        case 5: {
          const parsed = onboardingStep5Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { components } = parsed.data;

          const totalWeight = components.reduce((sum, c) => sum + c.weight_percent, 0);
          if (totalWeight !== 100) {
            return res.status(400).json({ success: false, error: { code: 'WEIGHT_SUM_ERROR', message: `Component weights must sum to 100. Current sum: ${totalWeight}` } });
          }

          await ensureSchoolSettings(school.id, school.name);
          await updateAcademicConfig(school.id, { assessment_components: components });

          stepData = { components };
          break;
        }

        case 6: {
          const parsed = onboardingStep6Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { first_name, last_name, email, phone } = parsed.data;

          const existingUser = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
          if (existingUser.rows[0]) {
            return res.status(409).json({ success: false, error: { code: 'EMAIL_IN_USE', message: 'A user with this email already exists' } });
          }

          const tempPassword = generateTempPassword();

          const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password: tempPassword,
            email_confirm: true,
          });
          if (authError || !authData?.user) {
            return res.status(500).json({ success: false, error: { code: 'AUTH_CREATE_FAILED', message: authError?.message ?? 'Failed to create principal account' } });
          }

          const userId = authData.user.id;

          await pool.query(
            `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, phone, is_active, teacher_mode)
             VALUES ($1, $2, $3, '', 'principal', $4, $5, $6, TRUE, 'subject')`,
            [userId, school.id, email, first_name, last_name, phone ?? null]
          );

          // Never persist the raw password — store a flag so the DB row is safe if read.
          stepData = { first_name, last_name, email, phone: phone ?? null, temp_password: '[cleared after email sent]' };
          extraResponseData = { principal_created: true, temp_password: tempPassword };
          break;
        }

        case 7: {
          stepData = {};
          break;
        }
      }

      const newStepEntry = {
        [stepNumber]: { completed: true, completed_at: new Date().toISOString(), ...stepData },
      };

      const updateResult = await pool.query(
        `UPDATE onboarding_sessions
         SET steps_completed = steps_completed || $1::jsonb, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(newStepEntry), req.params.sessionId]
      );
      const updatedSession = updateResult.rows[0];

      return res.json({ success: true, data: { step: stepNumber, completed: true, session: updatedSession, ...extraResponseData } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /onboarding/:sessionId/complete ─────────────────────────────────────
// Finalises onboarding: activates the school and sends a welcome email.

router.post(
  '/onboarding/:sessionId/complete',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = completeOnboardingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'You must accept the Terms of Service, Privacy Policy, Data Processing Agreement, and Acceptable Use Policy to continue' } });
      }

      const sessionResult = await pool.query(`SELECT * FROM onboarding_sessions WHERE id = $1`, [req.params.sessionId]);
      const session = sessionResult.rows[0];
      if (!session) {
        return res.status(404).json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Onboarding session not found' } });
      }
      if (session.status !== 'in_progress') {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_COMPLETED', message: `Onboarding session is already ${session.status}` } });
      }

      const stepsCompleted: Record<string, Record<string, unknown>> = session.steps_completed ?? {};
      const missing = [1, 2, 3, 4, 5, 6].filter(step => !(String(step) in stepsCompleted));
      if (missing.length > 0) {
        return res.status(400).json({ success: false, error: { code: 'INCOMPLETE_WIZARD', message: `Steps ${missing.join(', ')} are not yet complete` } });
      }

      const schoolResult = await pool.query(`SELECT * FROM schools WHERE id = $1`, [session.school_id]);
      const school = schoolResult.rows[0];

      await pool.query(
        `UPDATE schools SET is_active = TRUE, legal_terms_accepted_at = NOW(), legal_terms_accepted_ip = $2 WHERE id = $1`,
        [session.school_id, req.ip]
      );
      await pool.query(
        `UPDATE onboarding_sessions SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [req.params.sessionId]
      );

      const step6Data = stepsCompleted['6'] ?? {};
      let principalEmail = (step6Data.email as string | undefined) ?? null;
      if (!principalEmail) {
        const principalResult = await pool.query<{ email: string }>(
          `SELECT email FROM users WHERE school_id = $1 AND role = 'principal' LIMIT 1`,
          [session.school_id]
        );
        principalEmail = principalResult.rows[0]?.email ?? null;
      }

      if (principalEmail) {
        const firstName = (step6Data.first_name as string | undefined) ?? '';
        const storedPassword = (step6Data.temp_password as string | undefined) ?? '';
        const passwordCleared = storedPassword === '[cleared after email sent]';
        const appUrl = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
        const loginUrl = `${appUrl}/login`;
        const passwordLine = passwordCleared
          ? 'Temporary Password: [provided at account creation — please check with your Chronix administrator]'
          : `Temporary Password: ${storedPassword}`;
        const emailBody =
          `Hi ${firstName},\n\n` +
          `Welcome to Chronix Edu! Your school's account has been successfully set up and is now live and ready to use.\n\n` +
          `Here are your login details:\n\n` +
          `Login Portal: ${loginUrl}\n` +
          `Email: ${principalEmail}\n` +
          `${passwordLine}\n\n` +
          `For your security, you will be asked to set a new password the first time you log in.\n\n` +
          `GETTING STARTED\n\n` +
          `Here is a quick path to get your school fully set up:\n\n` +
          `1. Log in and create your new password\n` +
          `2. Add your school logo and branding under Settings → School Identity\n` +
          `3. Set up your classes and subjects under Settings → Roster\n` +
          `4. Add your teachers under Settings → Users\n` +
          `5. Register your students under Registrar → Students\n\n` +
          `If you have any questions getting started, simply reply to this email or reach us at support@chronixtechnology.com — we are happy to help.\n\n` +
          `You can review our Terms of Service, Privacy Policy, Data Processing Agreement, and Acceptable Use Policy at ${appUrl}/legal at any time.\n\n` +
          `Welcome aboard, and we look forward to supporting your school's journey.\n\n` +
          `Warm regards,\n` +
          `The Chronix Technology Team\n` +
          `support@chronixtechnology.com`;

        if (isEmailConfigured()) {
          await sendEmail(principalEmail, 'Welcome to Chronix Edu — Your School Portal is Now Live', emailBody);
        } else {
          console.log(`[onboarding] SendGrid not configured. Welcome email for ${principalEmail}:\n${emailBody}`);
        }
      }

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SCHOOL_ONBOARDED', session.school_id, JSON.stringify({ completed_steps: Object.keys(stepsCompleted), principal_email: principalEmail }), req.ip]
      );

      return res.json({
        success: true,
        data: {
          school_id: session.school_id,
          school_name: school.name,
          principal_email: principalEmail,
          is_active: true,
          message: 'School onboarded successfully. Welcome email sent.',
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /analytics/overview ───────────────────────────────────────────────────
// Platform-wide KPIs, computed live.

router.get(
  '/analytics/overview',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [totalSchools, activeSchools, totalStudents, mrr, trialCount, newSchoolsThisMonth, lastSnapshot] = await Promise.all([
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools`),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE is_active = true`),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM students`),
        pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(
             CASE WHEN billing_cycle = 'monthly' THEN amount_naira
                  WHEN billing_cycle = 'annual' THEN amount_naira / 12
                  ELSE 0 END
           ), 0) AS total
           FROM platform_subscriptions
           WHERE subscription_status = 'active'`
        ),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM platform_subscriptions WHERE subscription_status = 'trial'`),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE created_at >= date_trunc('month', NOW())`),
        pool.query<{ snapshot_date: string }>(`SELECT snapshot_date FROM platform_metrics_snapshots ORDER BY snapshot_date DESC LIMIT 1`),
      ]);

      return res.json({
        success: true,
        data: {
          total_schools: parseInt(totalSchools.rows[0].count, 10),
          active_schools: parseInt(activeSchools.rows[0].count, 10),
          total_students: parseInt(totalStudents.rows[0].count, 10),
          total_mrr_naira: Number(mrr.rows[0].total),
          trial_count: parseInt(trialCount.rows[0].count, 10),
          new_schools_this_month: parseInt(newSchoolsThisMonth.rows[0].count, 10),
          last_snapshot_date: lastSnapshot.rows[0]?.snapshot_date ?? null,
          computed_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /analytics/schools ────────────────────────────────────────────────────
// Per-school activity score based on logins, score entries, and attendance marks over the last 30 days.

router.get(
  '/analytics/schools',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query<{
        school_id: string;
        school_name: string;
        is_active: boolean;
        plan: string | null;
        subscription_status: string | null;
        logins_30d: string;
        score_entries_30d: string;
        attendance_marks_30d: string;
      }>(
        `SELECT
           s.id AS school_id,
           s.name AS school_name,
           s.is_active,
           ps.plan,
           ps.subscription_status,
           COALESCE(logins.cnt, 0) AS logins_30d,
           COALESCE(scores.cnt, 0) AS score_entries_30d,
           COALESCE(att.cnt, 0) AS attendance_marks_30d
         FROM schools s
         LEFT JOIN platform_subscriptions ps ON ps.school_id = s.id
         LEFT JOIN (
           SELECT school_id, COUNT(*) AS cnt FROM audit_logs
           WHERE action_type = 'LOGIN' AND created_at > NOW() - INTERVAL '30 days'
           GROUP BY school_id
         ) logins ON logins.school_id = s.id
         LEFT JOIN (
           SELECT school_id, COUNT(*) AS cnt FROM audit_logs
           WHERE action_type = 'SCORE_ENTERED' AND created_at > NOW() - INTERVAL '30 days'
           GROUP BY school_id
         ) scores ON scores.school_id = s.id
         LEFT JOIN (
           SELECT school_id, COUNT(*) AS cnt FROM attendance
           WHERE created_at > NOW() - INTERVAL '30 days'
           GROUP BY school_id
         ) att ON att.school_id = s.id`
      );

      const schools = result.rows
        .map(row => {
          const logins30d = parseInt(row.logins_30d, 10);
          const scoreEntries30d = parseInt(row.score_entries_30d, 10);
          const attendanceMarks30d = parseInt(row.attendance_marks_30d, 10);
          const activityScore = logins30d * 1 + scoreEntries30d * 2 + attendanceMarks30d * 1;

          return {
            school_id: row.school_id,
            school_name: row.school_name,
            is_active: row.is_active,
            plan: row.plan,
            subscription_status: row.subscription_status,
            activity_score: activityScore,
            is_dormant: activityScore === 0,
            logins_30d: logins30d,
            score_entries_30d: scoreEntries30d,
            attendance_marks_30d: attendanceMarks30d,
          };
        })
        .sort((a, b) => b.activity_score - a.activity_score);

      return res.json({ success: true, data: schools });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /analytics/feature-adoption ───────────────────────────────────────────
// Percentage of active schools that have used each major feature.

router.get(
  '/analytics/feature-adoption',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const activeResult = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE is_active = true`);
      const totalActive = parseInt(activeResult.rows[0].count, 10);

      const featureQueries = [
        { feature: 'sms', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM notification_logs WHERE channel = 'sms'` },
        { feature: 'paystack', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM payments WHERE method = 'paystack'` },
        { feature: 'timetable', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM timetable_slots` },
        { feature: 'assignments', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM assignments` },
        { feature: 'attendance', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM attendance` },
        { feature: 'results_published', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM result_status WHERE status = 'published'::chronixedu_result_status` },
      ];

      const results = await Promise.all(featureQueries.map(f => pool.query<{ cnt: string }>(f.sql)));

      const features = featureQueries.map((f, i) => {
        const schoolsUsing = parseInt(results[i].rows[0].cnt, 10);
        const adoptionPct = totalActive === 0 ? 0 : Math.round((schoolsUsing / totalActive) * 1000) / 10;
        return {
          feature: f.feature,
          schools_using: schoolsUsing,
          total_active: totalActive,
          adoption_pct: adoptionPct,
        };
      });

      return res.json({ success: true, data: features });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /analytics/growth ─────────────────────────────────────────────────────
// School and student counts by month for the last 12 months.

router.get(
  '/analytics/growth',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [schoolsResult, studentsResult] = await Promise.all([
        pool.query<{ month: string; count: string }>(
          `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*) AS count
           FROM schools
           WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
           GROUP BY 1`
        ),
        pool.query<{ month: string; count: string }>(
          `SELECT to_char(date_trunc('month', u.created_at), 'YYYY-MM') AS month, COUNT(*) AS count
           FROM students st
           JOIN users u ON u.id = st.user_id
           WHERE u.created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
           GROUP BY 1`
        ),
      ]);

      const months: string[] = [];
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }

      const schoolsByMonth = new Map(schoolsResult.rows.map(r => [r.month, parseInt(r.count, 10)]));
      const studentsByMonth = new Map(studentsResult.rows.map(r => [r.month, parseInt(r.count, 10)]));

      return res.json({
        success: true,
        data: {
          months,
          schools: months.map(m => schoolsByMonth.get(m) ?? 0),
          students: months.map(m => studentsByMonth.get(m) ?? 0),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /health/overview ──────────────────────────────────────────────────────
// Platform health indicators: active support sessions, recent audit activity,
// latest metrics snapshot, and recent error count from the log file (if accessible).

router.get(
  '/health/overview',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [activeSupportSessions, lastSnapshot, auditEvents24h] = await Promise.all([
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM support_sessions WHERE ended_at IS NULL`),
        pool.query(`SELECT * FROM platform_metrics_snapshots ORDER BY snapshot_date DESC LIMIT 1`),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM platform_audit_logs WHERE created_at > NOW() - INTERVAL '24 hours'`),
      ]);

      const { error_count_24h, log_note } = getRecentErrorCount();

      return res.json({
        success: true,
        data: {
          active_support_sessions: parseInt(activeSupportSessions.rows[0].count, 10),
          audit_events_24h: parseInt(auditEvents24h.rows[0].count, 10),
          last_snapshot: lastSnapshot.rows[0] ?? null,
          error_count_24h,
          log_note,
          checked_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /health/crons ─────────────────────────────────────────────────────────
// Status of every registered cron job, flagging any that haven't run recently.

router.get(
  '/health/crons',
  ...guard,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const crons = getCronStatus().map(cronRecord => {
        const expectedIntervalHours = parseExpectedIntervalHours(cronRecord.schedule);
        const isStale =
          cronRecord.last_run === null ||
          Date.now() - cronRecord.last_run.getTime() > expectedIntervalHours * 1.1 * 3600000;

        return {
          ...cronRecord,
          expected_interval_hours: expectedIntervalHours,
          is_stale: isStale,
        };
      });

      return res.json({ success: true, data: crons });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /announcements ───────────────────────────────────────────────────────
// Creates a platform announcement (not yet published).

router.post(
  '/announcements',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createAnnouncementSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { title, body, type, target_plans, scheduled_at, expires_at } = parsed.data;

      const result = await pool.query(
        `INSERT INTO platform_announcements (title, body, type, target_plans, scheduled_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [title, body, type, target_plans, scheduled_at ?? null, expires_at ?? null, req.user!.user_id]
      );

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /announcements ────────────────────────────────────────────────────────
// Lists announcements, optionally filtered by status.

router.get(
  '/announcements',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listAnnouncementsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { status } = parsed.data;

      let whereClause = '';
      if (status === 'published') {
        whereClause = `WHERE pa.published_at IS NOT NULL AND (pa.expires_at IS NULL OR pa.expires_at > NOW())`;
      } else if (status === 'scheduled') {
        whereClause = `WHERE pa.published_at IS NULL AND (pa.scheduled_at IS NULL OR pa.scheduled_at > NOW())`;
      } else if (status === 'expired') {
        whereClause = `WHERE pa.expires_at IS NOT NULL AND pa.expires_at < NOW()`;
      }

      const result = await pool.query(
        `SELECT pa.*, u.email AS created_by_email
         FROM platform_announcements pa
         JOIN users u ON u.id = pa.created_by
         ${whereClause}
         ORDER BY pa.created_at DESC`
      );

      return res.json({ success: true, data: result.rows });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /announcements/:id ──────────────────────────────────────────────────
// Updates an announcement that has not yet been published.

router.patch(
  '/announcements/:id',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existingResult = await pool.query(`SELECT * FROM platform_announcements WHERE id = $1`, [req.params.id]);
      const existing = existingResult.rows[0];
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'ANNOUNCEMENT_NOT_FOUND', message: 'Announcement not found' } });
      }
      if (existing.published_at) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_PUBLISHED', message: 'Cannot modify a published announcement' } });
      }

      const parsed = updateAnnouncementSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const params: unknown[] = [];
      const fields: string[] = [];
      for (const [key, value] of Object.entries(parsed.data)) {
        params.push(value);
        fields.push(`${key} = $${params.length}`);
      }
      fields.push(`updated_at = NOW()`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE platform_announcements SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );

      return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /announcements/:id ─────────────────────────────────────────────────
// Deletes an announcement that has not yet been published.

router.delete(
  '/announcements/:id',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existingResult = await pool.query(`SELECT id, published_at FROM platform_announcements WHERE id = $1`, [req.params.id]);
      const existing = existingResult.rows[0];
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'ANNOUNCEMENT_NOT_FOUND', message: 'Announcement not found' } });
      }
      if (existing.published_at) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_PUBLISHED', message: 'Cannot delete a published announcement' } });
      }

      await pool.query(`DELETE FROM platform_announcements WHERE id = $1`, [req.params.id]);

      return res.json({ success: true, data: { deleted: true, id: req.params.id } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /announcements/:id/publish ───────────────────────────────────────────
// Publishes an announcement immediately and emails matching school principals.

router.post(
  '/announcements/:id/publish',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existingResult = await pool.query(`SELECT * FROM platform_announcements WHERE id = $1`, [req.params.id]);
      const announcement = existingResult.rows[0];
      if (!announcement) {
        return res.status(404).json({ success: false, error: { code: 'ANNOUNCEMENT_NOT_FOUND', message: 'Announcement not found' } });
      }
      if (announcement.published_at) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_PUBLISHED', message: 'Announcement is already published' } });
      }

      const updateResult = await pool.query<{ published_at: string }>(
        `UPDATE platform_announcements SET published_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING published_at`,
        [req.params.id]
      );
      const publishedAt = updateResult.rows[0].published_at;

      const recipientsResult = await pool.query<{ email: string; first_name: string; school_name: string }>(
        `SELECT u.email, u.first_name, s.name AS school_name
         FROM users u
         JOIN schools s ON s.id = u.school_id
         JOIN platform_subscriptions ps ON ps.school_id = u.school_id
         WHERE u.role = 'principal'
           AND u.is_active = true
           AND s.is_active = true
           AND ps.plan = ANY($1::text[])`,
        [announcement.target_plans]
      );

      const subject = `[Chronix Edu] [${String(announcement.type).toUpperCase()}] — ${announcement.title}`;
      for (const recipient of recipientsResult.rows) {
        if (isEmailConfigured()) {
          await sendEmail(recipient.email, subject, announcement.body);
        } else {
          console.log(`[announcements] SendGrid not configured. Announcement email for ${recipient.email}:\n${subject}\n${announcement.body}`);
        }
      }
      const recipientsCount = recipientsResult.rows.length;

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, metadata, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [
          req.user!.user_id,
          'ANNOUNCEMENT_PUBLISHED',
          JSON.stringify({ announcement_id: req.params.id, target_plans: announcement.target_plans, recipients_count: recipientsCount }),
          req.ip,
        ]
      );

      return res.json({
        success: true,
        data: { announcement_id: req.params.id, published_at: publishedAt, recipients_count: recipientsCount },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /admins ──────────────────────────────────────────────────────────────
// Lists all platform admin (super_admin) accounts.

router.get(
  '/admins',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT id, email, first_name, last_name, created_at, last_login_at, is_active
         FROM users
         WHERE role = 'super_admin'
           AND email NOT LIKE 'deleted-admin-%@deleted.chronixedu.local'
         ORDER BY created_at ASC`
      );
      return res.json({ success: true, data: result.rows });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /admins ──────────────────────────────────────────────────────────────
// Creates a new platform admin account (Supabase Auth + local users row).

const createPlatformAdminSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

router.post(
  '/admins',
  ...rootGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createPlatformAdminSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { first_name, last_name, email, password } = parsed.data;

      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { first_name, last_name, role: 'super_admin' },
      });
      if (authError) {
        return res.status(400).json({ success: false, error: { code: 'AUTH_CREATE_FAILED', message: authError.message } });
      }

      const userId = authData.user.id;
      const bcrypt = await import('bcryptjs');
      const hashed = bcrypt.hashSync(password, 12);

      await pool.query(
        `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
         VALUES ($1, NULL, $2, $3, 'super_admin', $4, $5)`,
        [userId, email, hashed, first_name, last_name]
      );

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, metadata, ip_address)
         VALUES ($1, 'PLATFORM_ADMIN_CREATED', $2, $3, $4)`,
        [
          req.user!.user_id,
          userId,
          JSON.stringify({ email, first_name, last_name }),
          req.ip ?? null,
        ]
      );

      const welcomeBody = [
        `Hi ${first_name},`,
        ``,
        `You have been added as a platform administrator on Chronix Edu.`,
        ``,
        `Your login details:`,
        `  Email:    ${email}`,
        `  Password: ${password}`,
        ``,
        `Log in at: ${process.env.APP_URL ?? 'https://edu.chronixtechnology.com'}/login`,
        ``,
        `Please change your password after your first login.`,
        ``,
        `Chronix Technology Limited`,
      ].join('\n');

      await sendEmail(email, 'You have been added as a Chronix Edu platform admin', welcomeBody);

      return res.status(201).json({ success: true, data: { user_id: userId, email } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /admins/:id/resend-welcome ──────────────────────────────────────────
// Generates a Supabase recovery link and emails it to an existing platform admin.
// Used when the original welcome email was missed or needs to be re-triggered.

router.post(
  '/admins/:id/resend-welcome',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admin = await pool.query<{ id: string; email: string; first_name: string; is_active: boolean }>(
        `SELECT id, email, first_name, is_active FROM users WHERE id = $1 AND role = 'super_admin' AND school_id IS NULL`,
        [req.params.id]
      );
      if (!admin.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Platform admin not found' } });
      }

      const { email, first_name } = admin.rows[0];

      const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email });
      if (error) {
        return res.status(500).json({ success: false, error: { code: 'RESET_LINK_FAILED', message: error.message } });
      }

      const resetLink = data?.properties?.action_link ?? `${process.env.APP_URL ?? 'https://edu.chronixtechnology.com'}/login`;

      const emailBody = [
        `Hi ${first_name},`,
        ``,
        `You have been added as a platform administrator on Chronix Edu.`,
        ``,
        `Use the link below to set your password and access the platform:`,
        ``,
        `  ${resetLink}`,
        ``,
        `This link expires in 24 hours. After setting your password, log in at:`,
        `  ${process.env.APP_URL ?? 'https://edu.chronixtechnology.com'}/login`,
        ``,
        `Chronix Technology Limited`,
      ].join('\n');

      await sendEmail(email, 'You have been added as a Chronix Edu platform admin', emailBody);

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, metadata, ip_address)
         VALUES ($1, 'PLATFORM_ADMIN_WELCOME_RESENT', $2, $3, $4)`,
        [req.user!.user_id, req.params.id, JSON.stringify({ email }), req.ip ?? null]
      );

      return res.json({ success: true, data: { email } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /admins/:id/suspend ────────────────────────────────────────────────
// Suspends a platform admin — bans the Supabase Auth identity and flips the
// local is_active flag, which the login route now checks for every account.

async function countOtherActiveAdmins(excludeId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND is_active = true AND id != $1`,
    [excludeId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

router.patch(
  '/admins/:id/suspend',
  ...rootGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schoolActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      if (req.params.id === req.user!.user_id) {
        return res.status(400).json({ success: false, error: { code: 'CANNOT_SUSPEND_SELF', message: 'You cannot suspend your own account' } });
      }

      const adminResult = await pool.query<{ id: string; email: string; is_active: boolean; role: string }>(
        `SELECT id, email, is_active, role FROM users WHERE id = $1`,
        [req.params.id]
      );
      const admin = adminResult.rows[0];
      if (!admin || admin.role !== 'super_admin') {
        return res.status(404).json({ success: false, error: { code: 'ADMIN_NOT_FOUND', message: 'Platform admin not found' } });
      }
      if (!admin.is_active) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_SUSPENDED', message: 'Admin is already suspended' } });
      }
      if ((await countOtherActiveAdmins(req.params.id)) < 1) {
        return res.status(409).json({ success: false, error: { code: 'LAST_ACTIVE_ADMIN', message: 'Cannot suspend the only active platform admin' } });
      }

      const { reason } = parsed.data;

      await supabaseAdmin.auth.admin.updateUserById(req.params.id, { ban_duration: '87600h' });
      await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [req.params.id]);

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, metadata, ip_address)
         VALUES ($1, 'PLATFORM_ADMIN_SUSPENDED', $2, $3, $4)`,
        [req.user!.user_id, req.params.id, JSON.stringify({ reason, suspended_by: req.user!.email, email: admin.email }), req.ip]
      );

      return res.json({ success: true, data: { admin_id: req.params.id, is_active: false, reason } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── PATCH /admins/:id/reactivate ─────────────────────────────────────────────

router.patch(
  '/admins/:id/reactivate',
  ...rootGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schoolActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const adminResult = await pool.query<{ id: string; email: string; is_active: boolean; role: string }>(
        `SELECT id, email, is_active, role FROM users WHERE id = $1`,
        [req.params.id]
      );
      const admin = adminResult.rows[0];
      if (!admin || admin.role !== 'super_admin') {
        return res.status(404).json({ success: false, error: { code: 'ADMIN_NOT_FOUND', message: 'Platform admin not found' } });
      }
      if (admin.is_active) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_ACTIVE', message: 'Admin is already active' } });
      }

      const { reason } = parsed.data;

      await supabaseAdmin.auth.admin.updateUserById(req.params.id, { ban_duration: 'none' });
      await pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [req.params.id]);

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, metadata, ip_address)
         VALUES ($1, 'PLATFORM_ADMIN_REACTIVATED', $2, $3, $4)`,
        [req.user!.user_id, req.params.id, JSON.stringify({ reason, reactivated_by: req.user!.email, email: admin.email }), req.ip]
      );

      return res.json({ success: true, data: { admin_id: req.params.id, is_active: true, reason } });
    } catch (err) {
      return next(err);
    }
  }
);

// ── DELETE /admins/:id ───────────────────────────────────────────────────────
// Permanently revokes a platform admin's access: deletes their Supabase Auth
// identity (the password can never be used again, even via password reset) and
// anonymizes the local row. The row itself is kept rather than hard-deleted
// because platform_audit_logs.platform_admin_id and support_sessions reference
// it with a NOT NULL foreign key — removing the row would destroy the
// historical record of every platform action this admin ever took.

const deleteAdminSchema = z.object({
  confirmation_email: z.string().email(),
});

router.delete(
  '/admins/:id',
  ...rootGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = deleteAdminSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      if (req.params.id === req.user!.user_id) {
        return res.status(400).json({ success: false, error: { code: 'CANNOT_DELETE_SELF', message: 'You cannot delete your own account' } });
      }

      const adminResult = await pool.query<{ id: string; email: string; role: string }>(
        `SELECT id, email, role FROM users WHERE id = $1`,
        [req.params.id]
      );
      const admin = adminResult.rows[0];
      if (!admin || admin.role !== 'super_admin') {
        return res.status(404).json({ success: false, error: { code: 'ADMIN_NOT_FOUND', message: 'Platform admin not found' } });
      }
      if (admin.email.toLowerCase() !== parsed.data.confirmation_email.toLowerCase()) {
        return res.status(400).json({ success: false, error: { code: 'CONFIRMATION_FAILED', message: 'Confirmation email does not match' } });
      }
      if ((await countOtherActiveAdmins(req.params.id)) < 1) {
        return res.status(409).json({ success: false, error: { code: 'LAST_ACTIVE_ADMIN', message: 'Cannot delete the only active platform admin' } });
      }

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, metadata, ip_address)
         VALUES ($1, 'PLATFORM_ADMIN_DELETED', $2, $3, $4)`,
        [req.user!.user_id, req.params.id, JSON.stringify({ deleted_by: req.user!.email, original_email: admin.email }), req.ip]
      );

      try {
        await supabaseAdmin.auth.admin.deleteUser(req.params.id);
      } catch {
        // Best-effort — local lockout below still applies even if Auth deletion fails.
      }

      await pool.query(
        `UPDATE users
         SET email = $2, password_hash = $3, is_active = false, first_name = 'Deleted', last_name = 'Admin'
         WHERE id = $1`,
        [req.params.id, `deleted-admin-${req.params.id}@deleted.chronixedu.local`, randomUUID()]
      );

      return res.json({ success: true, data: { admin_id: req.params.id, deleted: true } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
