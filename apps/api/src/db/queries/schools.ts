import pool from '../client';

export interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  subscription_tier: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchoolWithSettings extends SchoolRow {
  identity_config: Record<string, unknown>;
  academic_config: Record<string, unknown>;
  notification_config: Record<string, unknown>;
  report_config: Record<string, unknown>;
}

export interface PayoutConfig {
  paystack_subaccount_code?: string;
  bank_code?: string;
  account_number?: string;
  account_name?: string;
  settlement_status: 'pending' | 'active' | 'failed';
  failure_reason?: string;
  updated_at?: string;
  updated_by?: string;
}

/**
 * Creates a dormant school. `is_active` is FALSE explicitly, NOT left to the column
 * default, which is TRUE.
 *
 * This inserts a school and nothing else — no principal, no users at all. With the
 * column default it produced a live, fully routable tenant that nobody could
 * administer, in a single request, for any super_admin. The onboarding wizard already
 * models this correctly: it creates with is_active = FALSE and flips it at
 * POST /onboarding/:sessionId/complete, which now refuses without a principal. This
 * brings the direct path in line, so "active" means "went through onboarding" on both
 * routes rather than on one.
 *
 * The school stays reachable to super_admins for onboarding; requireActiveSchool keeps
 * everyone else out until it is activated.
 */
export async function insertSchool(name: string, slug: string): Promise<SchoolRow> {
  const result = await pool.query<SchoolRow>(
    `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, FALSE) RETURNING id, name, slug, is_active, created_at, updated_at`,
    [name, slug]
  );
  return result.rows[0];
}

/**
 * A school with no principal is one nobody can administer. Migration 038 enforces this
 * on the FALSE -> TRUE transition of schools.is_active so a future writer cannot forget
 * it; callers use this first so the caller gets a clean 400 instead of a trigger's 500.
 */
export async function schoolHasPrincipal(schoolId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM users WHERE school_id = $1 AND role = 'principal' LIMIT 1`,
    [schoolId]
  );
  return rows.length > 0;
}

export async function insertSchoolSettings(
  schoolId: string,
  identityConfig: Record<string, unknown>,
  academicConfig: Record<string, unknown>
): Promise<{ id: string; school_id: string }> {
  const result = await pool.query(
    `INSERT INTO school_settings (school_id, identity_config, academic_config)
     VALUES ($1, $2, $3)
     RETURNING id, school_id`,
    [schoolId, JSON.stringify(identityConfig), JSON.stringify(academicConfig)]
  );
  return result.rows[0];
}

export async function findSchoolById(schoolId: string): Promise<SchoolWithSettings | null> {
  const result = await pool.query<SchoolWithSettings>(
    `SELECT s.id, s.name, s.slug, s.is_active, s.subscription_tier, s.created_at, s.updated_at,
            ss.identity_config, ss.academic_config, ss.notification_config, ss.report_config
     FROM schools s
     LEFT JOIN school_settings ss ON ss.school_id = s.id
     WHERE s.id = $1`,
    [schoolId]
  );
  return result.rows[0] ?? null;
}

export async function updateIdentityConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET identity_config = identity_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function updateAcademicConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET academic_config = academic_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function updateNotificationConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET notification_config = notification_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function updateReportConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET report_config = report_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function checkPublishedResultsExist(schoolId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::text AS count FROM result_status
       WHERE school_id = $1 AND status = 'published'::chronixedu_result_status`,
      [schoolId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    // result_status table not available — safe to proceed
    return false;
  }
}

export async function checkSubmittedResultsExist(schoolId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT (
         (SELECT COUNT(*) FROM subject_result_status WHERE school_id = $1 AND status = 'submitted')
         + (SELECT COUNT(*) FROM result_status
            WHERE school_id = $1 AND status IN ('submitted', 'approved'))
       )::text AS count`,
      [schoolId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    return false;
  }
}

/** ₦1,000. Chronix's guardrail on transaction cost, not a claim about any school's
 *  policy — the settings UI names it as ours so a school can see whose number it is. */
export const DEFAULT_MIN_PART_PAYMENT_KOBO = 100_000;

/**
 * The smallest part payment a parent may make online, in kobo.
 *
 * Flat, never a percentage: partial payment exists for the parent who cannot pay the
 * whole amount, and a percentage floor scales the barrier with the fee — 10% of a
 * ₦500,000 term is ₦50,000, which is exactly the parent the feature is for.
 *
 * A payment that CLEARS the balance is always allowed regardless of this figure; the
 * caller enforces that, and it is the case worth testing first. Returning the default
 * rather than null on a missing row is deliberate: an unset minimum must not mean "no
 * minimum", because the failure direction there is the school paying fees on ₦1 payments.
 */
/** Merges a patch into fee_config, like updateAcademicConfig does for academic_config. */
export async function updateFeeConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE school_settings
     SET fee_config = fee_config || $1::jsonb,
         updated_at = NOW()
     WHERE school_id = $2`,
    [JSON.stringify(patch), schoolId]
  );
}

export async function getMinPartPaymentKobo(schoolId: string): Promise<number> {
  const { rows } = await pool.query<{ min_part_payment_kobo: number | null }>(
    `SELECT (fee_config->>'min_part_payment_kobo')::bigint AS min_part_payment_kobo
       FROM school_settings WHERE school_id = $1`,
    [schoolId]
  );
  const configured = rows[0]?.min_part_payment_kobo;
  return configured !== null && configured !== undefined && Number(configured) > 0
    ? Number(configured)
    : DEFAULT_MIN_PART_PAYMENT_KOBO;
}

export async function getSchoolPayoutConfig(schoolId: string): Promise<PayoutConfig | null> {
  const result = await pool.query<{ payout_config: PayoutConfig }>(
    `SELECT payout_config FROM schools WHERE id = $1`,
    [schoolId]
  );
  if (result.rows.length === 0) return null;
  const config = result.rows[0].payout_config;
  return config && Object.keys(config).length > 0 ? config : null;
}

export async function updateSchoolPayoutConfig(schoolId: string, config: PayoutConfig): Promise<void> {
  await pool.query(
    `UPDATE schools SET payout_config = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(config), schoolId]
  );
}

export async function getSchoolNameAndEmail(schoolId: string): Promise<{ name: string; email: string | null } | null> {
  const result = await pool.query<{ name: string; email: string | null }>(
    `SELECT name, email FROM schools WHERE id = $1`,
    [schoolId]
  );
  return result.rows[0] ?? null;
}
