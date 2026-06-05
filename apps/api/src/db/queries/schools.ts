import pool from '../client';

export interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SchoolWithSettings extends SchoolRow {
  identity_config: Record<string, unknown>;
  academic_config: Record<string, unknown>;
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
    `SELECT s.id, s.name, s.slug, s.is_active, s.created_at, s.updated_at,
            ss.identity_config, ss.academic_config
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

export async function checkPublishedResultsExist(schoolId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::text AS count FROM result_status
       WHERE school_id = $1 AND status = 'published'`,
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
       WHERE school_id = $1 AND status = 'submitted'`,
      [schoolId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    return false;
  }
}
