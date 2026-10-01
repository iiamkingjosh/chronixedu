import { Router, Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { verifyToken, requireRole } from '../middleware/auth';
import { clientIp } from '../middleware/clientIp';
import { resetPasswordRedirect } from '../config/appUrls';
import { logger } from '../config/logger';
import pool from '../db/client';
import { supabaseAdmin } from '../supabaseClient';
import { sendEmail, isEmailConfigured } from '../services/emailService';
import { insertSchoolSettings, updateIdentityConfig, schoolHasPrincipal } from '../db/queries/schools';
import { getPlatformRevenue } from '../db/queries/platformRevenue';
import { planEnum } from '../services/planFeatures';
import { csvCell } from '../services/csv';
import { cache, schoolCacheKey } from '../services/cacheService';
import { newSchoolAcademicConfig } from '../services/schoolService';
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
  user_id: z
    .string()
    .regex(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6})$/i,
      'Enter a valid User ID (UUID) or 6-digit support code'
    ),
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
  plan: planEnum.optional(),
  // Demo and fixture tenants are hidden by default: this list gets shown on a screen
  // during sales calls, and "Bulk Import Commit Test School" sitting in it is its own
  // kind of problem. Opt in explicitly to administer them.
  include_demo: z.coerce.boolean().optional().default(false),
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

// amount_naira is DERIVED — the per-student rate × the students enrolled in the school's
// current session, recomputed by the database on every write (migrations 044/045). It is
// refused here rather than silently ignored: a caller that sent one would otherwise
// believe it had been set.
const derivedAmountRefused = z.undefined({
  error: "amount_naira is derived from the per-student rate and the school's current enrolment; it cannot be set",
}).optional(); // optional: the key may be absent; anything but undefined is refused

const createSubscriptionSchema = z.object({
  school_id: z.string().uuid(),
  plan: planEnum,
  // Termly is the default: ₦800 per student per term (decided 30 Sep 2026, migration 046).
  billing_cycle: z.enum(['monthly', 'termly', 'annual']).default('termly'),
  amount_naira: derivedAmountRefused,
  trial_ends_at: z.string().optional(),
});

/**
 * When a subscription is next billed, and on what basis — the two must travel together,
 * because a blank date means different things (doctrine 8):
 *   next_term      termly: the school's next term start (next_term_start, migration 046)
 *   not_yet_known  termly, and no future term is set yet — the normal case after onboarding
 *   not_billed     trial
 *   stored / not_set  monthly or annual: the stored column, as before
 * Derived on read, never stored: term dates are editable and sessions roll over.
 */
function nextBillingSql(ps: string): string {
  return `CASE WHEN ${ps}.billing_cycle = 'termly' THEN next_term_start(${ps}.school_id) ELSE ${ps}.next_billing_date END`;
}
function nextBillingBasisSql(ps: string): string {
  return `CASE WHEN ${ps}.plan = 'trial' THEN 'not_billed'
               WHEN ${ps}.billing_cycle = 'termly' THEN CASE WHEN next_term_start(${ps}.school_id) IS NULL THEN 'not_yet_known' ELSE 'next_term' END
               WHEN ${ps}.next_billing_date IS NULL THEN 'not_set' ELSE 'stored' END`;
}

/**
 * The trigger that derives amount_naira refuses two states with their own SQLSTATEs.
 * Both are the caller's to fix, so they answer 409 with the envelope's error shape rather
 * than the generic 500 a database exception would otherwise become.
 */
function billingRefusal(err: unknown): { code: string; message: string } | null {
  const code = (err as { code?: string })?.code;
  if (code === 'BL001') {
    return { code: 'BILLING_RATE_NOT_CONFIGURED', message: 'No per-student rate is configured. Set platform_pricing_config before creating or changing a paid subscription.' };
  }
  if (code === 'BL002') {
    return { code: 'NO_CURRENT_SESSION', message: 'This school has no current academic session, so a paid subscription cannot be priced. Set its current session first.' };
  }
  return null;
}

// If a trial subscription is created with no trial_ends_at, it runs for this
// many days — keeps a caller-omitted date from meaning "never expires".
const DEFAULT_TRIAL_LENGTH_DAYS = 30;

function defaultTrialEndsAt(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + DEFAULT_TRIAL_LENGTH_DAYS);
  return d.toISOString();
}

const updateSubscriptionSchema = z
  .object({
    plan: planEnum.optional(),
    subscription_status: z.enum(['active', 'suspended', 'cancelled', 'trial', 'grace', 'read_only']).optional(),
    billing_cycle: z.enum(['monthly', 'termly', 'annual']).optional(),
    amount_naira: derivedAmountRefused,
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

// is_demo is REQUIRED, with no default: whether a school is a customer is a stated fact, never an
// unset field (doctrine 8). A default of FALSE is how a typo'd test school ("guyg ") was counted as
// a customer in every platform total. Names are trimmed: that same school reached production with
// a trailing space, which makes two schools look identical in a list.
const isDemoChoice = z.boolean({
  error: (issue) => issue.input === undefined
    ? 'is_demo is required: say whether this school is a customer (false) or a demo/test school (true)'
    : 'is_demo must be true or false',
});

const startOnboardingSchema = z.object({
  school_name: z.string().trim().min(3),
  school_email: z.string().trim().email(),
  is_demo: isDemoChoice,
});

const onboardingStep1Schema = z.object({
  name: z.string().trim().min(1),
  address: z.string().min(1),
  phone: z.string().min(1),
});

const onboardingStep2Schema = z
  .object({
    // Optional, as the form's label says: blank ('') or omitted both mean "no motto". It was
    // min(1), so the form's blank motto was refused and a raw zod error reached the screen.
    motto: z.string().trim().max(500).optional(),
    primary_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex colour').optional(),
    admission_prefix: z.string().min(1).optional(),
  })
  .refine(obj => Object.keys(obj).length > 0, { message: 'At least one field is required' });

const onboardingTermSchema = z.object({
  name: z.string().min(1),
  start_date: z.string(),
  end_date: z.string(),
});

/**
 * Validates a set of term date ranges: each end after its start, and no two terms
 * overlapping. Shared by onboarding and the post-onboarding add/edit term routes.
 * Overlap matters at runtime — findTermForDate() resolves a date to a term with
 * `LIMIT 1` and no ordering, so overlapping terms would attribute attendance to an
 * arbitrary one of them.
 */
export function validateTermRanges(
  terms: Array<{ name: string; start_date: string; end_date: string }>,
  ctx: z.RefinementCtx
): void {
  const parsed = terms.map((term, idx) => {
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
    return { idx, name: term.name, start, end };
  });

  const usable = parsed.filter(t => !isNaN(t.start.getTime()) && !isNaN(t.end.getTime()) && t.end > t.start);
  const byStart = [...usable].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1];
    const curr = byStart[i];
    if (curr.start <= prev.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${curr.name}" starts on or before "${prev.name}" ends — terms cannot overlap`,
        path: ['terms', curr.idx, 'start_date'],
      });
    }
  }
}

/**
 * Step 3: ONE term — the term the school is starting in, which becomes its current term.
 * The wizard used to offer three rows and pre-fill all three names, so its "is this row
 * touched?" check was always true and Next never enabled. With a single required term there
 * is no optional-row inference left to get wrong. Later terms are added afterwards via
 * POST /:schoolId/sessions/:sessionId/terms, which keeps the overlap checks
 * (validateTermRanges) that a single term cannot need.
 */
const onboardingStep3Schema = z
  .object({
    session_name: z.string().trim().min(1),
    term: onboardingTermSchema,
  })
  .superRefine((data, ctx) => validateTermRanges([data.term], ctx));

// Step 4: the principal account (was step 6 before 1 Oct 2026).
// The principal's address is typed twice (item H, 1 Oct 2026). A mistyped address ties the
// principal account to a stranger's mailbox, and "Forgot password" then sends the reset link there.
const onboardingStep4Schema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().trim().email(),
  email_confirmation: z.string().trim(),
  phone: z.string().optional(),
}).refine(d => d.email.toLowerCase() === d.email_confirmation.toLowerCase(), {
  path: ['email_confirmation'],
  message: 'The two email addresses do not match',
});

// Both stated, never defaulted (doctrine 8). principal_email_read_back is the operator's statement
// that they read the address back to the principal by phone and the principal confirmed it. The
// system cannot check that; it records who said so and when (PRINCIPAL_EMAIL_READ_BACK_CONFIRMED).
// That prevents nothing and records everything, which is all an audit row is for (doctrine 6).
const completeOnboardingSchema = z.object({
  accepted_legal_terms: z.literal(true),
  // Checked after the wizard's structural refusals (missing steps, no principal), so it never
  // masks the real reason: "read back the principal's address" means nothing with no principal.
  principal_email_read_back: z.boolean().optional(),
});

/**
 * The wizard is five screens since 1 Oct 2026: 1 Info, 2 Branding, 3 Calendar, 4 Admin,
 * 5 Review. Review is POST /complete, not a saved step, so the SAVED steps — the ones
 * steps_completed records and /complete requires — are 1..4. The grading and assessment
 * steps were removed: the principal sets both in Settings, and nothing is seeded in their
 * place (doctrine 8).
 *
 * Renumbered rather than keeping 1,2,3,6 with gaps. The only stored sessions were one
 * completed (Moses's pilot, keys 1-6 under the old numbering) and one abandoned in-progress
 * row, deleted on 1 Oct 2026. Nothing reads a completed session's keys — /complete and
 * resume both refuse anything not in_progress — so the old keys stay as history and
 * cannot be misread.
 */
const ONBOARDING_SAVED_STEPS = [1, 2, 3, 4] as const;
const ONBOARDING_TOTAL_STEPS = ONBOARDING_SAVED_STEPS.length;

// ── Announcement schemas ─────────────────────────────────────────────────────

const announcementTypeEnum = z.enum(['info', 'warning', 'critical', 'maintenance']);
const announcementPlanEnum = planEnum;

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

// csvCell moved to services/csv.ts (the school export uses it too); re-exported here
// because its unit test imports it from this module.
export { csvCell };

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
        `SELECT id, school_id, role, email, title FROM users
         WHERE (id::text = $1 OR support_code = $1) AND school_id = $2 AND is_active = true`,
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
        [req.user!.user_id, school_id, target.id, reason, '[]']
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
        [req.user!.user_id, 'IMPERSONATION_START', school_id, target.id, JSON.stringify({ reason, target_role: target.role }), clientIp(req), sessionId]
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
      const { page, search, status, plan, include_demo } = parsed.data;

      const params: unknown[] = [];
      const where: string[] = [];

      if (!include_demo) { where.push('schools.is_demo = false'); }
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
           schools.is_demo,
           schools.payout_config->>'settlement_status' AS payout_status,
           platform_subscriptions.plan,
           platform_subscriptions.subscription_status,
           platform_subscriptions.amount_naira,
           ${nextBillingSql('platform_subscriptions')} AS next_billing_date,
           ${nextBillingBasisSql('platform_subscriptions')} AS next_billing_basis,
           (SELECT COUNT(*) FROM students WHERE students.school_id = schools.id) AS student_count,
           billable_student_count(schools.id) AS billable_students,
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
      const schoolResult = await pool.query(
        `SELECT id, name, slug, email, address, phone, is_active, subscription_tier, legal_terms_accepted_at, created_at
         FROM schools WHERE id = $1`,
        [req.params.schoolId]
      );
      const school = schoolResult.rows[0];
      if (!school) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }

      const settingsResult = await pool.query(`SELECT * FROM school_settings WHERE school_id = $1`, [req.params.schoolId]);
      const subscriptionResult = await pool.query(
        `SELECT ps.*, ${nextBillingSql('ps')} AS next_billing_date, ${nextBillingBasisSql('ps')} AS next_billing_basis
           FROM platform_subscriptions ps WHERE ps.school_id = $1`,
        [req.params.schoolId]
      );
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
        [req.user!.user_id, 'SCHOOL_SUSPENDED', req.params.schoolId, JSON.stringify({ reason, suspended_by: req.user!.email }), clientIp(req)]
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

      // Same invariant as onboarding completion. Without this, a dormant school created
      // by POST /api/schools could be reactivated one request later into a live tenant
      // with no principal — the same hole, two calls instead of one. Migration 038
      // enforces it on the column too; this is here so the caller gets a 400 rather
      // than a trigger's 500.
      if (!(await schoolHasPrincipal(req.params.schoolId))) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_PRINCIPAL',
            message: 'This school has no principal account and cannot be activated. Create one first — an active school with no principal is one nobody can administer.',
          },
        });
      }

      await pool.query(`UPDATE schools SET is_active = true WHERE id = $1`, [req.params.schoolId]);
      cache.del(schoolCacheKey(req.params.schoolId, 'data'));

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SCHOOL_REACTIVATED', req.params.schoolId, JSON.stringify({ reason, reactivated_by: req.user!.email }), clientIp(req)]
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

// AUDIT H-3: root admin only — any other super_admin could previously wipe a
// school with nothing more than its (non-secret) slug.
router.delete(
  '/schools/:schoolId/data',
  ...rootGuard,
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
        return res.status(400).json({ success: false, error: { code: 'CONFIRMATION_FAILED', message: 'Confirmation token does not match school slug' } });
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
          [req.user!.user_id, 'SCHOOL_DATA_WIPED', req.params.schoolId, JSON.stringify({ wiped_by: req.user!.email, school_slug: school.slug }), clientIp(req)]
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
           ${nextBillingSql('ps')} AS next_billing_date,
           ${nextBillingBasisSql('ps')} AS next_billing_basis,
           ps.trial_ends_at,
           ps.created_at,
           (${nextBillingSql('ps')} - (NOW() AT TIME ZONE 'Africa/Lagos')::date) AS days_until_billing
         FROM platform_subscriptions ps
         JOIN schools s ON s.id = ps.school_id
         ${whereClause}
         ORDER BY ps.created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
      );

      // MRR from the one source (getPlatformRevenue). This summary had its own SUM, which
      // counted monthly subscriptions only — it would have shown termly revenue as nothing.
      const [revenue, summaryResult] = await Promise.all([
        getPlatformRevenue(),
        pool.query<{ active_count: string; trial_count: string; grace_count: string; read_only_count: string; suspended_count: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE subscription_status = 'active') AS active_count,
             COUNT(*) FILTER (WHERE subscription_status = 'trial') AS trial_count,
             COUNT(*) FILTER (WHERE subscription_status = 'grace') AS grace_count,
             COUNT(*) FILTER (WHERE subscription_status = 'read_only') AS read_only_count,
             COUNT(*) FILTER (WHERE subscription_status = 'suspended') AS suspended_count
           FROM platform_subscriptions`
        ),
      ]);
      const summaryRow = summaryResult.rows[0];
      const summary = {
        total_mrr_naira: revenue.total_mrr_kobo / 100,
        active_count: parseInt(summaryRow.active_count, 10),
        trial_count: parseInt(summaryRow.trial_count, 10),
        grace_count: parseInt(summaryRow.grace_count, 10),
        read_only_count: parseInt(summaryRow.read_only_count, 10),
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
      // Single source, shared with /api/partner/revenue so the ERP and this dashboard
      // cannot report different MRR. It also excludes demo and suspended schools, which
      // this route did not and /analytics/overview did — a latent disagreement between
      // two figures in the same product.
      const revenue = await getPlatformRevenue();
      return res.json({ success: true, data: revenue });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * Why a school's billable count can be smaller than its roll — three different reasons that
 * all read as a bare number, and a ₦0 that means "nobody is enrolled yet" must not look like a
 * ₦0 that means "there is no current session". `null` when there is nothing to explain,
 * including a school with nobody on its roll at all (an honest zero).
 */
type EnrolmentNote = 'no_current_session' | 'none_enrolled' | 'some_not_enrolled';
function enrolmentNote(onRoll: number, billable: number, hasCurrentSession: boolean): EnrolmentNote | null {
  if (!hasCurrentSession) return 'no_current_session';
  if (onRoll === 0) return null;
  if (billable === 0) return 'none_enrolled';
  return billable < onRoll ? 'some_not_enrolled' : null;
}

// ── GET /schools/:id/billing-preview ─────────────────────────────────────────
// What a subscription for this school is billed, from the same definition the database
// trigger uses (billable_student_count, migration 045): students enrolled in the current
// session × the configured per-student rate. The super-admin UI shows this read-only
// where it used to collect a number the trigger then discarded.

router.get(
  '/schools/:id/billing-preview',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const school = await pool.query(`SELECT id FROM schools WHERE id = $1`, [req.params.id]);
      if (!school.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }
      const { rows } = await pool.query<{
        billable_students: number; students_on_roll: number; current_session_id: string | null; price_per_student_kobo: string | null; amount_naira: string | null;
      }>(
        `WITH f AS (
           SELECT billable_student_count($1) AS billable_students,
                  (SELECT COUNT(*)::int FROM students WHERE school_id = $1) AS students_on_roll,
                  (SELECT id FROM academic_sessions WHERE school_id = $1 AND is_current = TRUE) AS current_session_id,
                  (SELECT price_per_student_kobo FROM platform_pricing_config LIMIT 1) AS price_per_student_kobo
         )
         SELECT billable_students, students_on_roll, current_session_id, price_per_student_kobo,
                CASE WHEN price_per_student_kobo IS NOT NULL AND current_session_id IS NOT NULL
                     THEN ROUND((billable_students::numeric * price_per_student_kobo) / 100.0, 2)::text
                END AS amount_naira
           FROM f`,
        [req.params.id]
      );
      const r = rows[0];
      return res.json({
        success: true,
        data: {
          billable_students: r.billable_students,
          students_on_roll: r.students_on_roll,
          enrolment_note: enrolmentNote(r.students_on_roll, r.billable_students, r.current_session_id !== null),
          current_session_id: r.current_session_id,
          rate_configured: r.price_per_student_kobo !== null,
          price_per_student_kobo: r.price_per_student_kobo === null ? null : Number(r.price_per_student_kobo),
          amount_naira: r.amount_naira,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /subscriptions ─────────────────────────────────────────────────────
// Creates a subscription for a school that doesn't yet have one. amount_naira is derived
// by the database (rate × current enrolment) — see billingRefusal for the two refusals.

router.post(
  '/subscriptions',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { school_id, plan, billing_cycle } = parsed.data;
      const trial_ends_at = plan === 'trial' ? (parsed.data.trial_ends_at ?? defaultTrialEndsAt()) : parsed.data.trial_ends_at;

      const schoolResult = await pool.query(`SELECT id FROM schools WHERE id = $1`, [school_id]);
      if (!schoolResult.rows[0]) {
        return res.status(404).json({ success: false, error: { code: 'SCHOOL_NOT_FOUND', message: 'School not found' } });
      }

      const existing = await pool.query(`SELECT id FROM platform_subscriptions WHERE school_id = $1`, [school_id]);
      if (existing.rows[0]) {
        return res.status(409).json({ success: false, error: { code: 'SUBSCRIPTION_EXISTS', message: 'School already has a subscription. Use PATCH to update.' } });
      }

      const subscriptionStatus = plan === 'trial' ? 'trial' : 'active';

      let subscription;
      try {
        const result = await pool.query(
          `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, trial_ends_at, subscription_status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [school_id, plan, billing_cycle, trial_ends_at ?? null, subscriptionStatus]
        );
        subscription = result.rows[0];
      } catch (err) {
        const refused = billingRefusal(err);
        if (refused) return res.status(409).json({ success: false, error: refused });
        throw err;
      }

      await pool.query(`UPDATE schools SET subscription_tier = $1 WHERE id = $2`, [plan, school_id]);
      cache.del(schoolCacheKey(school_id, 'data'));

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SUBSCRIPTION_CREATED', school_id, JSON.stringify({ plan, billing_cycle, amount_naira: subscription.amount_naira }), clientIp(req)]
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

      // What the row will hold after this write. A caller may name only the field it means
      // to change; the consequences it does not name are decided here, for every caller.
      const effective = { ...parsed.data };
      const resultingPlan = effective.plan ?? existing.plan;
      const resultingStatus = effective.subscription_status ?? existing.subscription_status;
      // trial, grace and read_only are the trial gate's states (migration 046); a paid plan
      // is in none of them.
      if (resultingPlan !== 'trial' && ['trial', 'grace', 'read_only'].includes(resultingStatus)) {
        if (effective.subscription_status !== undefined) {
          // Asked for outright: refuse, rather than write a state the trial-expiry job reads
          // as an expired trial.
          return res.status(400).json({
            success: false,
            error: { code: 'INCONSISTENT_STATUS', message: `A ${resultingPlan} plan cannot have '${resultingStatus}' status; use 'active'.` },
          });
        }
        // Leaving 'trial' for a paid plan: the status follows the plan. Chronix High School's
        // plan was changed to premium with the status left 'trial', and five days later the
        // trial-expiry job — which selects on status alone — suspended it as an expired
        // trial. Fixed at the route so the UI is not the only safe caller.
        effective.subscription_status = 'active';
      }

      // amount_naira is not here: it is derived by the database on this very UPDATE.
      const SUBSCRIPTION_FIELDS = ['plan', 'subscription_status', 'billing_cycle', 'next_billing_date', 'trial_ends_at'] as const;
      const params: unknown[] = [];
      const fields: string[] = [];
      for (const field of SUBSCRIPTION_FIELDS) {
        if (effective[field] !== undefined) {
          params.push(effective[field]);
          fields.push(`${field} = $${params.length}`);
        }
      }
      fields.push(`updated_at = NOW()`);
      params.push(req.params.id);

      let updated;
      try {
        const result = await pool.query(
          `UPDATE platform_subscriptions SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params
        );
        updated = result.rows[0];
      } catch (err) {
        const refused = billingRefusal(err);
        if (refused) return res.status(409).json({ success: false, error: refused });
        throw err;
      }

      if (parsed.data.plan !== undefined) {
        await pool.query(`UPDATE schools SET subscription_tier = $1 WHERE id = $2`, [parsed.data.plan, existing.school_id]);
      }
      // Always: the cached school row carries the subscription status the gate reads.
      cache.del(schoolCacheKey(existing.school_id, 'data'));

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SUBSCRIPTION_UPDATED', existing.school_id, JSON.stringify({ changes: req.body, effective, previous_plan: existing.plan, previous_status: existing.subscription_status }), clientIp(req)]
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

      const existingResult = await pool.query<{ id: string; school_id: string; plan: string; subscription_status: string }>(
        `SELECT id, school_id, plan, subscription_status FROM platform_subscriptions WHERE id = $1`,
        [req.params.id]
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' } });
      }
      // A trial in grace or read-only can be extended too — it is a way back, and the status
      // is recomputed from the new end date with the job's own rule (Africa/Lagos, the end
      // date inclusive, then 14 days of grace).
      if (existing.plan !== 'trial' || !['trial', 'grace', 'read_only'].includes(existing.subscription_status)) {
        return res.status(400).json({ success: false, error: { code: 'NOT_A_TRIAL', message: 'Can only extend trial subscriptions' } });
      }

      const result = await pool.query<{ trial_ends_at: string; subscription_status: string }>(
        `UPDATE platform_subscriptions
            SET trial_ends_at = trial_ends_at + (INTERVAL '1 day' * $2::integer),
                subscription_status = CASE
                  WHEN ((trial_ends_at + (INTERVAL '1 day' * $2::integer)) AT TIME ZONE 'Africa/Lagos')::date >= (NOW() AT TIME ZONE 'Africa/Lagos')::date THEN 'trial'
                  WHEN ((trial_ends_at + (INTERVAL '1 day' * $2::integer)) AT TIME ZONE 'Africa/Lagos')::date + 14 >= (NOW() AT TIME ZONE 'Africa/Lagos')::date THEN 'grace'
                  ELSE 'read_only' END,
                updated_at = NOW()
          WHERE id = $1
          RETURNING trial_ends_at, subscription_status`,
        [req.params.id, days]
      );
      const newTrialEndsAt = result.rows[0].trial_ends_at;
      const newStatus = result.rows[0].subscription_status;
      cache.del(schoolCacheKey(existing.school_id, 'data'));

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'TRIAL_EXTENDED', existing.school_id, JSON.stringify({ days_added: days, new_trial_ends_at: newTrialEndsAt, status_before: existing.subscription_status, status_after: newStatus }), clientIp(req)]
      );

      return res.json({ success: true, data: { subscription_id: req.params.id, days_added: days, new_trial_ends_at: newTrialEndsAt, subscription_status: newStatus } });
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

      const result = await pool.query<{ id: string; school_id: string; plan: string; subscription_status: string }>(
        `SELECT ps.id, ps.school_id, ps.plan, ps.subscription_status
         FROM platform_subscriptions ps
         JOIN schools s ON s.id = ps.school_id
         WHERE ps.id = $1`,
        [req.params.id]
      );
      const subscription = result.rows[0];
      if (!subscription) {
        return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' } });
      }
      if (subscription.subscription_status === 'cancelled') {
        return res.status(409).json({
          success: false,
          error: { code: 'SUBSCRIPTION_CANCELLED', message: 'This subscription is cancelled; nothing was recorded. Reinstate it before recording a payment.' },
        });
      }

      // A payment against a suspended subscription reactivates it: money received is the
      // strongest evidence there is of a live customer, and before this the payment was
      // recorded and reconciled nothing — Chronix High School, ₦50,000 on 28 Sep 2026,
      // against a row the trial-expiry job had suspended. The SCHOOL's is_active is not
      // touched: a policy suspension is a different decision with its own route. The
      // response says which happened.
      // Grace and read-only (the trial gate, migration 046) restore the same way. A payment
      // against a TRIAL-plan subscription also moves the plan to premium: "active" on a trial
      // plan would be free and never expire. [MOSES] decision recorded in docs/AUDIT-2026-09.md.
      const reactivated = ['suspended', 'grace', 'read_only'].includes(subscription.subscription_status);
      const upgradedFromTrial = subscription.plan === 'trial';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (reactivated || upgradedFromTrial) {
          await client.query(
            `UPDATE platform_subscriptions SET subscription_status = 'active', plan = CASE WHEN plan = 'trial' THEN 'premium' ELSE plan END, updated_at = NOW() WHERE id = $1`,
            [subscription.id]
          );
        }
        if (upgradedFromTrial) {
          await client.query(`UPDATE schools SET subscription_tier = 'premium' WHERE id = $1`, [subscription.school_id]);
        }
        await client.query(
          `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            req.user!.user_id,
            'MANUAL_PAYMENT_RECORDED',
            subscription.school_id,
            JSON.stringify({
              amount, reference, payment_date, notes: notes ?? null, plan: subscription.plan, recorded_by: req.user!.email,
              status_before: subscription.subscription_status, subscription_reactivated: reactivated,
              plan_before: subscription.plan, upgraded_from_trial: upgradedFromTrial,
            }),
            clientIp(req),
          ]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const refused = billingRefusal(err);
        if (refused) return res.status(409).json({ success: false, error: refused });
        throw err;
      } finally {
        client.release();
      }
      cache.del(schoolCacheKey(subscription.school_id, 'data'));

      return res.json({
        success: true,
        data: {
          subscription_id: req.params.id, school_id: subscription.school_id, amount_recorded: amount, reference, payment_date,
          subscription_status_before: subscription.subscription_status,
          subscription_status: reactivated || upgradedFromTrial ? 'active' : subscription.subscription_status,
          subscription_reactivated: reactivated,
          plan: upgradedFromTrial ? 'premium' : subscription.plan,
          upgraded_from_trial: upgradedFromTrial,
        },
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

/** Ensures a school_settings row exists for the school: identity, plus calendar templates only. */
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
  // No grading scale, pass mark or assessment components — the school sets its own (doctrine 8).
  await insertSchoolSettings(schoolId, identityConfig, newSchoolAcademicConfig());
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
      const { school_name, school_email, is_demo } = parsed.data;

      const existing = await pool.query(`SELECT id FROM schools WHERE email = $1`, [school_email]);
      if (existing.rows[0]) {
        return res.status(409).json({ success: false, error: { code: 'SCHOOL_EMAIL_EXISTS', message: 'A school with this email already exists' } });
      }

      const slug = generateOnboardingSlug(school_name);

      const schoolResult = await pool.query<{ id: string; slug: string }>(
        `INSERT INTO schools (name, slug, email, is_active, subscription_tier, is_demo)
         VALUES ($1, $2, $3, FALSE, 'trial', $4)
         RETURNING id, slug`,
        [school_name, slug, school_email, is_demo]
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
        [req.user!.user_id, 'ONBOARDING_STARTED', school.id, JSON.stringify({ school_name, school_email, is_demo }), clientIp(req)]
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

      // Explicit column list (not SELECT *) — schools.payout_config holds an
      // unmasked bank account number and must never be returned to the client.
      const schoolResult = await pool.query(
        `SELECT id, name, slug, email, address, phone, is_active, subscription_tier, legal_terms_accepted_at, created_at
         FROM schools WHERE id = $1`,
        [session.school_id]
      );
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
// Saves progress for one saved step (1-4) of the onboarding wizard; step 5 is /complete.

router.patch(
  '/onboarding/:sessionId/step/:stepNumber',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stepNumber = Number(req.params.stepNumber);
      if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > ONBOARDING_TOTAL_STEPS) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_STEP', message: `Step number must be between 1 and ${ONBOARDING_TOTAL_STEPS}` } });
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
          const { session_name, term } = parsed.data;

          // One term: the session spans it for now and grows as later terms are added.
          const sessionRowResult = await pool.query<{ id: string }>(
            `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
             VALUES ($1, $2, $3, $4, TRUE)
             RETURNING id`,
            [school.id, session_name, term.start_date, term.end_date]
          );
          const academicSessionId = sessionRowResult.rows[0].id;

          await pool.query(
            `INSERT INTO terms (session_id, school_id, name, start_date, end_date, is_current)
             VALUES ($1, $2, $3, $4, $5, TRUE)`,
            [academicSessionId, school.id, term.name, term.start_date, term.end_date]
          );

          stepData = { session_name, term };
          break;
        }

        case 4: {
          const parsed = onboardingStep4Schema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
          }
          const { first_name, last_name, email, phone } = parsed.data;

          const existingUser = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
          if (existingUser.rows[0]) {
            return res.status(409).json({ success: false, error: { code: 'EMAIL_IN_USE', message: 'A user with this email already exists' } });
          }

          // No password (item H, 1 Oct 2026). The principal sets their own from the link /complete
          // emails, so nobody, the operator included, ever sees or passes on a password. It used to
          // return a temporary one to the operator's screen, to be relayed by hand.
          const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
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

          stepData = { first_name, last_name, email, phone: phone ?? null };
          extraResponseData = { principal_created: true };
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
      const missing = ONBOARDING_SAVED_STEPS.filter(step => !(String(step) in stepsCompleted));
      if (missing.length > 0) {
        return res.status(400).json({ success: false, error: { code: 'INCOMPLETE_WIZARD', message: `Steps ${missing.join(', ')} are not yet complete` } });
      }

      const schoolResult = await pool.query(`SELECT * FROM schools WHERE id = $1`, [session.school_id]);
      const school = schoolResult.rows[0];

      // A school with no principal is a school nobody can administer. This lookup
      // already existed below, but only to find an address for the welcome email —
      // the school went live first and the absence of a principal was silent. Step 4
      // (the principal step; step 6 before 1 Oct 2026) is completable without creating one, so the wizard could finish and hand over
      // a tenant with no way in. Gate on it BEFORE activating anything.
      const principalRow = await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE school_id = $1 AND role = 'principal' LIMIT 1`,
        [session.school_id]
      );
      if (principalRow.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_PRINCIPAL',
            message: 'This school has no principal account. Create one in step 4 (Admin) before completing onboarding — without it nobody can administer the school.',
          },
        });
      }

      // Absent or false is refused: the statement is made, never assumed (doctrine 8).
      if (parsed.data.principal_email_read_back !== true) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PRINCIPAL_EMAIL_NOT_READ_BACK',
            message: "Read the principal's email address back to them by phone, and tick that they confirmed it, before completing onboarding.",
          },
        });
      }

      // Resolved above as the activation gate; step 4's blob wins only because it is
      // what the operator just typed.
      const step4Data = stepsCompleted['4'] ?? {};
      const principalEmail = (step4Data.email as string | undefined) ?? principalRow.rows[0].email;

      // The operator's statement that the address was read back and confirmed, recorded before
      // anything is activated or sent, with who said it, when, and the address they confirmed.
      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, 'PRINCIPAL_EMAIL_READ_BACK_CONFIRMED', $2, $3, $4)`,
        [req.user!.user_id, session.school_id, JSON.stringify({
          principal_email: principalEmail,
          asserted_confirmed: true,
          note: "The operator's statement that they read this address back to the principal by phone and the principal confirmed it. Not verified by the system.",
        }), clientIp(req)]
      );

      // The set-password link, generated before activation: if Supabase cannot make one, nothing
      // has been switched on and the operator can simply try again.
      const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: principalEmail,
        options: { redirectTo: resetPasswordRedirect() },
      });
      const setPasswordLink = linkData?.properties?.action_link;
      if (linkError || !setPasswordLink) {
        logger.error('onboarding_set_password_link_failed', { school_id: session.school_id, error: linkError?.message ?? 'no link returned' });
        return res.status(502).json({
          success: false,
          error: { code: 'SET_PASSWORD_LINK_FAILED', message: 'Could not create the principal\'s set-password link. Nothing was activated; try again.' },
        });
      }

      await pool.query(
        `UPDATE schools SET is_active = TRUE, legal_terms_accepted_at = NOW(), legal_terms_accepted_ip = $2 WHERE id = $1`,
        [session.school_id, clientIp(req)]
      );
      await pool.query(
        `UPDATE onboarding_sessions SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [req.params.sessionId]
      );

      let welcomeEmail: 'sent' | 'not_sent' = 'not_sent';
      {
        const firstName = (step4Data.first_name as string | undefined) ?? '';
        const appUrl = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
        const loginUrl = `${appUrl}/login`;
        const emailBody =
          `Hi ${firstName},\n\n` +
          `Welcome to Chronix Edu! Your school's account has been successfully set up and is now live and ready to use.\n\n` +
          `Set your password using this link:\n\n` +
          `${setPasswordLink}\n\n` +
          `The link works once and expires. If it has expired, go to ${loginUrl}, choose "Forgot password" and enter ${principalEmail}; a new link will be sent to this address.\n\n` +
          `Your login email is ${principalEmail}. Nobody at Chronix knows or will ask for your password.\n\n` +
          `GETTING STARTED\n\n` +
          `Here is a quick path to get your school fully set up:\n\n` +
          `1. Set your password using the link above, then log in at ${loginUrl}\n` +
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
          welcomeEmail = 'sent';
        } else {
          // Never print the body: it carries a working set-password link.
          logger.warn('onboarding_welcome_email_not_sent', { school_id: session.school_id, reason: 'email is not configured on this server' });
        }
      }

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user!.user_id, 'SCHOOL_ONBOARDED', session.school_id, JSON.stringify({ completed_steps: Object.keys(stepsCompleted), principal_email: principalEmail, welcome_email: welcomeEmail }), clientIp(req)]
      );

      return res.json({
        success: true,
        data: {
          school_id: session.school_id,
          school_name: school.name,
          principal_email: principalEmail,
          is_active: true,
          welcome_email: welcomeEmail,
          // It said "Welcome email sent" even when none was (email not configured).
          message: welcomeEmail === 'sent'
            ? 'School onboarded. The principal has been emailed a link to set their password.'
            : 'School onboarded, but the welcome email was NOT sent: email is not configured on this server. The principal can use "Forgot password" on the login page with their address.',
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
      // Every count here is platform scale — the number quoted to an investor or a
      // prospective school — so each one excludes schools that are not customers
      // (is_demo: test fixtures, sandbox and sales-demo tenants). Previously all of
      // these counted every row regardless of state, which made 45 fixture schools
      // read as platform scale. Filtering on is_active alone would not have fixed it:
      // it would have made total_schools identical to active_schools, and it would
      // have written off suspended real customers, who still belong in these totals.
      //
      // total_schools counts customers whatever their suspension state; the metrics
      // that describe CURRENT activity (students, trials, MRR) additionally require
      // is_active, because a suspended school is not contributing any of them today.
      const [totalSchools, activeSchools, totalStudents, mrr, trialCount, newSchoolsThisMonth, lastSnapshot] = await Promise.all([
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE is_demo = false`),
        pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE is_active = true AND is_demo = false`),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) FROM students st
             JOIN schools s ON s.id = st.school_id
            WHERE s.is_active = true AND s.is_demo = false`
        ),
        // The one MRR source. This was a third copy of the arithmetic, and it counted a
        // termly subscription as nothing.
        getPlatformRevenue(),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) FROM platform_subscriptions ps
             JOIN schools s ON s.id = ps.school_id
            WHERE ps.subscription_status = 'trial' AND s.is_active = true AND s.is_demo = false`
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) FROM schools
            WHERE created_at >= date_trunc('month', NOW()) AND is_demo = false`
        ),
        pool.query<{ snapshot_date: string }>(`SELECT snapshot_date FROM platform_metrics_snapshots ORDER BY snapshot_date DESC LIMIT 1`),
      ]);

      return res.json({
        success: true,
        data: {
          total_schools: parseInt(totalSchools.rows[0].count, 10),
          active_schools: parseInt(activeSchools.rows[0].count, 10),
          total_students: parseInt(totalStudents.rows[0].count, 10),
          total_mrr_naira: mrr.total_mrr_kobo / 100,
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
        // Delivered texts only: a 'failed' or 'throttled' row is not a school using SMS.
        { feature: 'sms', sql: `SELECT COUNT(DISTINCT school_id) AS cnt FROM notification_logs WHERE channel = 'sms' AND status = 'sent'` },
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

      const ANNOUNCEMENT_FIELDS = ['title', 'body', 'type', 'target_plans', 'scheduled_at', 'expires_at'] as const;
      const params: unknown[] = [];
      const fields: string[] = [];
      for (const field of ANNOUNCEMENT_FIELDS) {
        if (parsed.data[field] !== undefined) {
          params.push(parsed.data[field]);
          fields.push(`${field} = $${params.length}`);
        }
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
      const safeBody = sanitizeHtml(announcement.body, { allowedTags: [], allowedAttributes: {} });
      for (const recipient of recipientsResult.rows) {
        if (isEmailConfigured()) {
          await sendEmail(recipient.email, subject, safeBody);
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
          clientIp(req),
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
          clientIp(req) ?? null,
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
        [req.user!.user_id, req.params.id, JSON.stringify({ email }), clientIp(req) ?? null]
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

// Ends any support sessions this platform admin currently has open and blacklists
// their scoped impersonation tokens. Without this, suspending or deleting an admin
// mid-impersonation would leave that session usable until it naturally expired.
async function terminateActiveSupportSessions(adminId: string): Promise<void> {
  const activeSessions = await pool.query<{ id: string }>(
    `SELECT id FROM support_sessions WHERE platform_admin_id = $1 AND ended_at IS NULL`,
    [adminId]
  );
  if (activeSessions.rows.length === 0) return;

  if (redis) {
    for (const { id } of activeSessions.rows) {
      const storedToken = await redis.get(`support_session_token:${id}`);
      if (storedToken) {
        await redis.set(`blacklisted_token:${storedToken}`, '1', 'EX', 30 * 60);
        await redis.del(`support_session_token:${id}`);
      }
    }
  }

  await pool.query(
    `UPDATE support_sessions SET ended_at = NOW() WHERE platform_admin_id = $1 AND ended_at IS NULL`,
    [adminId]
  );
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

      // Immediately update the is_active cache so verifyToken blocks the admin on
      // the next request instead of trusting the up-to-5-minute-stale cached value.
      if (redis) {
        await redis.set(`user_active:${req.params.id}`, '0', 'EX', 300);
      }
      // End any impersonation session this admin currently has open and blacklist
      // its scoped token so it can't outlive the suspension.
      await terminateActiveSupportSessions(req.params.id);

      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, metadata, ip_address)
         VALUES ($1, 'PLATFORM_ADMIN_SUSPENDED', $2, $3, $4)`,
        [req.user!.user_id, req.params.id, JSON.stringify({ reason, suspended_by: req.user!.email, email: admin.email }), clientIp(req)]
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
        [req.user!.user_id, req.params.id, JSON.stringify({ reason, reactivated_by: req.user!.email, email: admin.email }), clientIp(req)]
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
        [req.user!.user_id, req.params.id, JSON.stringify({ deleted_by: req.user!.email, original_email: admin.email }), clientIp(req)]
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

      // Immediately update the is_active cache so verifyToken blocks the admin on
      // the next request instead of trusting the up-to-5-minute-stale cached value.
      if (redis) {
        await redis.set(`user_active:${req.params.id}`, '0', 'EX', 300);
      }
      // End any impersonation session this admin currently has open and blacklist
      // its scoped token so it can't outlive the deletion.
      await terminateActiveSupportSessions(req.params.id);

      return res.json({ success: true, data: { admin_id: req.params.id, deleted: true } });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
