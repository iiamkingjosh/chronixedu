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

export async function insertSchool(name: string, slug: string): Promise<SchoolRow> {
  const result = await pool.query<SchoolRow>(
    `INSERT INTO schools (name, slug) VALUES ($1, $2) RETURNING id, name, slug, is_active, created_at, updated_at`,
    [name, slug]
  );
  return result.rows[0];
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
      `SELECT COUNT(*)::text AS count FROM result_status
       WHERE school_id = $1 AND status = 'submitted'::chronixedu_result_status`,
      [schoolId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    return false;
  }
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
