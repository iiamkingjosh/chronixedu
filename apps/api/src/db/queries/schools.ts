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

/**
 * Merges `patch` into the school's academic_config at the top level — so a patch that
 * carries only `level_overrides` replaces that key and leaves the school-wide scale and
 * pass mark alone.
 *
 * An upsert, not an UPDATE. It was `UPDATE … WHERE school_id = $2`, which matches zero
 * rows for a school with no school_settings row — and the route still answered
 * "Academic config updated". A save that reports success and changes nothing. Measured
 * 28 Sep 2026: the one customer school has a row; 42 of the 44 fixture schools, created
 * by raw INSERT, do not — so this was latent rather than live. But the level-overrides screen
 * saves through here, and it should not inherit a success message that can be false.
 * Every column has a default and school_id is UNIQUE, so the insert branch is complete.
 */
export async function updateAcademicConfig(
  schoolId: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return mergeSettingsColumn('academic_config', schoolId, patch);
}

/**
 * Merge `patch` into one JSONB settings column and return the PRIOR value of exactly the
 * keys patched — `null` for a key that had none — read under the lock the write holds.
 *
 * Every settings audit row records `{ field, value }` for old and new. The academic-config
 * and fee-config routes passed a literal `null` as the old value, so the audit trail said
 * "previous value: null" for every change to grading scales, pass marks, level overrides
 * and the part-payment minimum, whatever had actually been there. A missing value
 * announces itself; a recorded `null` reads as authoritative — the second of two saves
 * eighteen seconds apart claimed its predecessor had set nothing.
 *
 * Three statements, one transaction, one connection:
 *   1. ensure the row exists (so there is always something to lock);
 *   2. SELECT … FOR UPDATE — waits for any concurrent writer, then reads the latest
 *      committed value: exactly the state this write replaces;
 *   3. merge.
 * A first attempt did it in one statement — a FOR UPDATE CTE beside the upsert CTE. It
 * returned nothing: the upsert CTE ran first, and FOR UPDATE skips a row already modified
 * by the same command. The positive test (the second save must name the first's value)
 * caught it on its first run; an assertion that the old value is null would have passed.
 * Dropping FOR UPDATE instead would have let a concurrent save record a prior value from
 * before a write that had already committed.
 *
 * Also an upsert rather than `UPDATE … WHERE school_id`, which matched zero rows for a
 * school without a settings row and still let the route answer "updated".
 */
async function mergeSettingsColumn(
  column: 'academic_config' | 'fee_config',
  schoolId: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO school_settings (school_id) VALUES ($1) ON CONFLICT (school_id) DO NOTHING`,
      [schoolId]
    );
    const { rows } = await client.query<{ cfg: Record<string, unknown> | null }>(
      `SELECT ${column} AS cfg FROM school_settings WHERE school_id = $1 FOR UPDATE`,
      [schoolId]
    );
    await client.query(
      `UPDATE school_settings SET ${column} = ${column} || $1::jsonb, updated_at = NOW() WHERE school_id = $2`,
      [JSON.stringify(patch), schoolId]
    );
    await client.query('COMMIT');
    const prior = rows[0]?.cfg ?? {};
    return Object.fromEntries(Object.keys(patch).map(k => [k, prior[k] ?? null]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ClassLevelRow {
  level: string;
  class_names: string[];
}

/** Every distinct classes.level in the school, with the classes that carry it. */
export async function listClassLevels(schoolId: string): Promise<ClassLevelRow[]> {
  const result = await pool.query<ClassLevelRow>(
    `SELECT level, array_agg(name ORDER BY name) AS class_names
       FROM classes
      WHERE school_id = $1 AND level IS NOT NULL AND level <> ''
      GROUP BY level
      ORDER BY level`,
    [schoolId]
  );
  return result.rows;
}

/** academic_config read straight from the row — no cache, so a screen that just saved sees what it saved. */
export async function findAcademicConfig(schoolId: string): Promise<Record<string, unknown>> {
  const result = await pool.query<{ academic_config: Record<string, unknown> }>(
    `SELECT academic_config FROM school_settings WHERE school_id = $1`,
    [schoolId]
  );
  return result.rows[0]?.academic_config ?? {};
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
): Promise<Record<string, unknown>> {
  return mergeSettingsColumn('fee_config', schoolId, patch);
}

export async function resolveMinPartPayment(
  schoolId: string
): Promise<{ kobo: number; isConfigured: boolean }> {
  const { rows } = await pool.query<{ min_part_payment_kobo: number | null }>(
    `SELECT (fee_config->>'min_part_payment_kobo')::bigint AS min_part_payment_kobo
       FROM school_settings WHERE school_id = $1`,
    [schoolId]
  );
  // `rows[0]?.` and not `rows[0].`: 42 of 45 schools have no school_settings row at all,
  // so the settings-less case is the majority rather than an edge.
  const configured = rows[0]?.min_part_payment_kobo;
  const isConfigured = configured !== null && configured !== undefined && Number(configured) > 0;
  // isConfigured is RETURNED rather than recomputed by callers from the value. A school
  // that deliberately sets ₦1,000 — the figure we recommend, so the likeliest choice —
  // must not be told forever that it has not chosen one. "What is the value" and "did
  // anyone choose it" are two facts, and the second cannot be derived from the first.
  return { kobo: isConfigured ? Number(configured) : DEFAULT_MIN_PART_PAYMENT_KOBO, isConfigured };
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
