import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export type BehaviourSeverity = 'minor' | 'serious' | 'suspension';

export interface BehaviourRecordRow {
  id: string;
  school_id: string;
  student_id: string;
  term_id: string;
  class_id: string;
  incident_type: string;
  description: string | null;
  sanction: string | null;
  severity: BehaviourSeverity;
  reported_by: string;
  date: string;
  parent_notified_at: string | null;
  created_at: string;
}

export interface BehaviourHistoryRow extends BehaviourRecordRow {
  class_name: string;
  term_name: string;
  reported_by_name: string;
}

export interface BehaviourSummaryRecentRow extends BehaviourHistoryRow {
  student_name: string;
  admission_no: string;
}

export interface BehaviourSummary {
  by_severity: { minor: number; serious: number; suspension: number };
  total: number;
  recent: BehaviourSummaryRecentRow[];
}

// ── Queries ────────────────────────────────────────────────────────────────────

/** Insert a behaviour record. Suspensions are notified immediately (parent_notified_at set now); other severities are left unset (queued). */
export async function createBehaviourRecord(data: {
  school_id: string;
  student_id: string;
  term_id: string;
  class_id: string;
  incident_type: string;
  description: string | null;
  sanction: string | null;
  severity: BehaviourSeverity;
  reported_by: string;
  date: string;
}): Promise<BehaviourRecordRow> {
  const parentNotifiedAt = data.severity === 'suspension' ? new Date().toISOString() : null;
  const result = await pool.query<BehaviourRecordRow>(
    `INSERT INTO behaviour_records
       (school_id, student_id, term_id, class_id, incident_type, description, sanction, severity, reported_by, date, parent_notified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.school_id,
      data.student_id,
      data.term_id,
      data.class_id,
      data.incident_type,
      data.description,
      data.sanction,
      data.severity,
      data.reported_by,
      data.date,
      parentNotifiedAt,
    ]
  );
  return result.rows[0];
}

/** Full behaviour history for a student, optionally filtered to one term. */
export async function getStudentBehaviourHistory(
  studentId: string,
  schoolId: string,
  termId?: string
): Promise<BehaviourHistoryRow[]> {
  const params: string[] = [studentId, schoolId];
  let where = `br.student_id = $1 AND br.school_id = $2`;
  if (termId) {
    params.push(termId);
    where += ` AND br.term_id = $${params.length}`;
  }

  const result = await pool.query<BehaviourHistoryRow>(
    `SELECT br.*, c.name AS class_name, t.name AS term_name,
            (u.first_name || ' ' || u.last_name) AS reported_by_name
     FROM behaviour_records br
     JOIN classes c ON c.id = br.class_id
     JOIN terms t ON t.id = br.term_id
     JOIN users u ON u.id = br.reported_by
     WHERE ${where}
     ORDER BY br.date DESC, br.created_at DESC`,
    params
  );
  return result.rows;
}

/** Number of incidents recorded for a student in a given term — used for the parent portal behaviour card. */
export async function getStudentIncidentCount(studentId: string, schoolId: string, termId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM behaviour_records WHERE student_id = $1 AND school_id = $2 AND term_id = $3`,
    [studentId, schoolId, termId]
  );
  return result.rows[0].count;
}

/** School-wide behaviour summary for a term — used for the principal dashboard. */
export async function getSchoolBehaviourSummary(schoolId: string, termId: string): Promise<BehaviourSummary> {
  const counts = await pool.query<{ severity: BehaviourSeverity; count: number }>(
    `SELECT severity, COUNT(*)::int AS count FROM behaviour_records WHERE school_id = $1 AND term_id = $2 GROUP BY severity`,
    [schoolId, termId]
  );

  const by_severity = { minor: 0, serious: 0, suspension: 0 };
  let total = 0;
  for (const row of counts.rows) {
    by_severity[row.severity] = row.count;
    total += row.count;
  }

  const recent = await pool.query<BehaviourSummaryRecentRow>(
    `SELECT br.*, c.name AS class_name, t.name AS term_name,
            (u.first_name || ' ' || u.last_name) AS reported_by_name,
            (su.first_name || ' ' || su.last_name) AS student_name, s.admission_no
     FROM behaviour_records br
     JOIN classes c ON c.id = br.class_id
     JOIN terms t ON t.id = br.term_id
     JOIN users u ON u.id = br.reported_by
     JOIN students s ON s.id = br.student_id
     JOIN users su ON su.id = s.user_id
     WHERE br.school_id = $1 AND br.term_id = $2
     ORDER BY br.date DESC, br.created_at DESC
     LIMIT 50`,
    [schoolId, termId]
  );

  return { by_severity, total, recent: recent.rows };
}
