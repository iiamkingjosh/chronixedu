import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ComponentRow {
  id: string;
  config_id: string;
  name: string;
  max_score: number;
  weight_percent: number;
  display_order: number;
}

export interface ConfigRow {
  id: string;
  school_id: string;
  term_id: string;
  term_name: string | null;
  subject_id: string | null;
  subject_name: string | null;
  class_level: string | null;
  is_default: boolean;
  is_locked: boolean;
}

export interface ConfigWithComponents extends ConfigRow {
  components: ComponentRow[];
}

export interface ConfigWithComponentsAndPriority extends ConfigWithComponents {
  priority_level: number;
}

export interface ComponentInput {
  name: string;
  max_score: number;
  weight_percent: number;
  display_order: number;
}

// ── Create ─────────────────────────────────────────────────────────────────────

export async function insertAssessmentConfig(
  schoolId: string,
  termId: string,
  subjectId: string | null,
  classLevel: string | null,
  isDefault: boolean,
  components: ComponentInput[]
): Promise<ConfigWithComponents> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const configResult = await client.query<ConfigRow>(
      `INSERT INTO assessment_configs (school_id, term_id, subject_id, class_level, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, school_id, term_id, subject_id, class_level, is_default`,
      [schoolId, termId, subjectId ?? null, classLevel ?? null, isDefault]
    );
    const config = configResult.rows[0];

    const insertedComponents: ComponentRow[] = [];
    for (const comp of components) {
      const compResult = await client.query<ComponentRow>(
        `INSERT INTO assessment_components (config_id, name, max_score, weight_percent, display_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, config_id, name, max_score, weight_percent, display_order`,
        [config.id, comp.name, comp.max_score, comp.weight_percent, comp.display_order]
      );
      insertedComponents.push(compResult.rows[0]);
    }

    // Deferred constraint trigger validates weight_percent total = 100 at COMMIT
    await client.query('COMMIT');

    return { ...config, components: insertedComponents };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function listAssessmentConfigs(schoolId: string): Promise<ConfigWithComponents[]> {
  const result = await pool.query<ConfigRow & { components: ComponentRow[] }>(
    `SELECT
       ac.id, ac.school_id, ac.term_id, ac.subject_id, ac.class_level, ac.is_default,
       t.name    AS term_name,
       subj.name AS subject_name,
       EXISTS (
         SELECT 1 FROM scores s
         WHERE s.school_id = ac.school_id AND s.term_id = ac.term_id
       ) AS is_locked,
       COALESCE(
         json_agg(
           json_build_object(
             'id',            comp.id,
             'config_id',     comp.config_id,
             'name',          comp.name,
             'max_score',     comp.max_score,
             'weight_percent',comp.weight_percent,
             'display_order', comp.display_order
           ) ORDER BY comp.display_order
         ) FILTER (WHERE comp.id IS NOT NULL),
         '[]'::json
       ) AS components
     FROM assessment_configs ac
     LEFT JOIN terms        t    ON t.id    = ac.term_id
     LEFT JOIN subjects     subj ON subj.id = ac.subject_id
     LEFT JOIN assessment_components comp ON comp.config_id = ac.id
     WHERE ac.school_id = $1
     GROUP BY ac.id, t.name, subj.name
     ORDER BY ac.is_default DESC, ac.term_id, ac.class_level NULLS LAST, ac.subject_id NULLS LAST`,
    [schoolId]
  );
  return result.rows;
}

export async function findConfigById(id: string, schoolId: string): Promise<ConfigRow | null> {
  const result = await pool.query<ConfigRow>(
    `SELECT id, school_id, term_id, subject_id, class_level, is_default
     FROM assessment_configs
     WHERE id = $1 AND school_id = $2`,
    [id, schoolId]
  );
  return result.rows[0] ?? null;
}

// Exported for use by the scoring module — see also resolveAssessmentConfig below
export async function fetchConfigWithComponents(configId: string): Promise<ConfigWithComponents | null> {
  const [configResult, compResult] = await Promise.all([
    pool.query<ConfigRow>(
      `SELECT id, school_id, term_id, subject_id, class_level, is_default
       FROM assessment_configs WHERE id = $1`,
      [configId]
    ),
    pool.query<ComponentRow>(
      `SELECT id, config_id, name, max_score, weight_percent, display_order
       FROM assessment_components WHERE config_id = $1 ORDER BY display_order`,
      [configId]
    ),
  ]);
  const config = configResult.rows[0];
  if (!config) return null;
  return { ...config, components: compResult.rows };
}

// ── Resolve — 4-level priority ─────────────────────────────────────────────────
//
// Priority:
//   1 — exact subject_id + class_level match
//   2 — subject_id only (class_level IS NULL in config)
//   3 — class_level only (subject_id IS NULL in config)
//   4 — school-wide default (is_default = TRUE)

export async function resolveAssessmentConfig(
  schoolId: string,
  classId: string,
  subjectId: string,
  termId: string
): Promise<ConfigWithComponentsAndPriority | null> {
  // Look up the class level so we can match against assessment_configs.class_level
  const classResult = await pool.query<{ level: string }>(
    `SELECT level FROM classes WHERE id = $1 AND school_id = $2`,
    [classId, schoolId]
  );
  const classLevel = classResult.rows[0]?.level ?? null;

  // Single query selects the highest-priority matching config
  const configResult = await pool.query<ConfigRow & { priority_level: number }>(
    `SELECT
       id, school_id, term_id, subject_id, class_level, is_default,
       CASE
         WHEN subject_id = $2 AND class_level = $3       THEN 1
         WHEN subject_id = $2 AND class_level IS NULL    THEN 2
         WHEN subject_id IS NULL AND class_level = $3    THEN 3
         WHEN is_default = TRUE                          THEN 4
       END AS priority_level
     FROM assessment_configs
     WHERE school_id = $1 AND term_id = $4
       AND (
         (subject_id = $2 AND class_level = $3)
         OR (subject_id = $2 AND class_level IS NULL)
         OR (subject_id IS NULL AND class_level = $3)
         OR (is_default = TRUE)
       )
     ORDER BY priority_level
     LIMIT 1`,
    [schoolId, subjectId, classLevel, termId]
  );

  const config = configResult.rows[0];
  if (!config) return null;

  const compResult = await pool.query<ComponentRow>(
    `SELECT id, config_id, name, max_score, weight_percent, display_order
     FROM assessment_components
     WHERE config_id = $1
     ORDER BY display_order`,
    [config.id]
  );

  return { ...config, components: compResult.rows };
}

// ── Update ─────────────────────────────────────────────────────────────────────

export async function scoresExistForConfigTerm(configId: string, schoolId: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM scores
       WHERE school_id = $1
         AND term_id = (
           SELECT term_id FROM assessment_configs WHERE id = $2 AND school_id = $1
         )
     ) AS exists`,
    [schoolId, configId]
  );
  return result.rows[0].exists;
}

export async function updateAssessmentConfig(
  configId: string,
  schoolId: string,
  components: ComponentInput[],
  metadata?: {
    subject_id?: string | null;
    class_level?: string | null;
    is_default?: boolean;
  }
): Promise<ConfigWithComponents> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Replace all components atomically; deferred trigger validates total at COMMIT
    await client.query(
      `DELETE FROM assessment_components WHERE config_id = $1`,
      [configId]
    );

    const newComponents: ComponentRow[] = [];
    for (const comp of components) {
      const compResult = await client.query<ComponentRow>(
        `INSERT INTO assessment_components (config_id, name, max_score, weight_percent, display_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, config_id, name, max_score, weight_percent, display_order`,
        [configId, comp.name, comp.max_score, comp.weight_percent, comp.display_order]
      );
      newComponents.push(compResult.rows[0]);
    }

    if (metadata && Object.keys(metadata).length > 0) {
      const setParts: string[] = [];
      const params: unknown[] = [configId, schoolId];

      if ('subject_id' in metadata) {
        params.push(metadata.subject_id ?? null);
        setParts.push(`subject_id = $${params.length}`);
      }
      if ('class_level' in metadata) {
        params.push(metadata.class_level ?? null);
        setParts.push(`class_level = $${params.length}`);
      }
      if ('is_default' in metadata) {
        params.push(metadata.is_default);
        setParts.push(`is_default = $${params.length}`);
      }

      await client.query(
        `UPDATE assessment_configs SET ${setParts.join(', ')} WHERE id = $1 AND school_id = $2`,
        params
      );
    }

    // Deferred trigger fires at COMMIT — validates weight_percent total = 100
    await client.query('COMMIT');

    const config = await fetchConfigWithComponents(configId);
    return config!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
