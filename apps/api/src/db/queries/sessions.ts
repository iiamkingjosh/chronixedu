import pool from '../client';

export interface SessionRow {
  id: string;
  school_id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
}

export interface TermRow {
  id: string;
  session_id: string;
  school_id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
}

export interface SessionWithTerms extends SessionRow {
  terms: TermRow[];
}

export async function insertSession(
  schoolId: string,
  name: string,
  startDate: string,
  endDate: string
): Promise<SessionRow> {
  const result = await pool.query<SessionRow>(
    `INSERT INTO academic_sessions (school_id, name, start_date, end_date)
     VALUES ($1, $2, $3, $4)
     RETURNING id, school_id, name, start_date, end_date, is_current`,
    [schoolId, name, startDate, endDate]
  );
  return result.rows[0];
}

export async function listSessionsWithTerms(schoolId: string): Promise<SessionWithTerms[]> {
  const result = await pool.query<SessionWithTerms>(
    `SELECT
       s.id, s.school_id, s.name, s.start_date, s.end_date, s.is_current,
       COALESCE(
         json_agg(
           json_build_object(
             'id',         t.id,
             'session_id', t.session_id,
             'school_id',  t.school_id,
             'name',       t.name,
             'start_date', t.start_date,
             'end_date',   t.end_date,
             'is_current', t.is_current
           ) ORDER BY t.start_date
         ) FILTER (WHERE t.id IS NOT NULL),
         '[]'::json
       ) AS terms
     FROM academic_sessions s
     LEFT JOIN terms t ON t.session_id = s.id
     WHERE s.school_id = $1
     GROUP BY s.id
     ORDER BY s.start_date DESC`,
    [schoolId]
  );
  return result.rows;
}

export async function findSessionById(
  sessionId: string,
  schoolId: string
): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>(
    `SELECT id, school_id, name, start_date, end_date, is_current
     FROM academic_sessions
     WHERE id = $1 AND school_id = $2`,
    [sessionId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function insertTerm(
  sessionId: string,
  schoolId: string,
  name: string,
  startDate: string,
  endDate: string
): Promise<TermRow> {
  const result = await pool.query<TermRow>(
    `INSERT INTO terms (session_id, school_id, name, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, session_id, school_id, name, start_date, end_date, is_current`,
    [sessionId, schoolId, name, startDate, endDate]
  );
  return result.rows[0];
}

export async function activateSession(schoolId: string, sessionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear any existing current session for this school
    await client.query(
      `UPDATE academic_sessions SET is_current = FALSE WHERE school_id = $1 AND is_current = TRUE`,
      [schoolId]
    );
    // Set the target session as current — partial unique index enforces one-current-per-school at DB level
    await client.query(
      `UPDATE academic_sessions SET is_current = TRUE WHERE id = $1 AND school_id = $2`,
      [sessionId, schoolId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getCurrentContext(
  schoolId: string
): Promise<{ session: SessionRow | null; term: TermRow | null }> {
  const [sessionResult, termResult] = await Promise.all([
    pool.query<SessionRow>(
      `SELECT id, school_id, name, start_date, end_date, is_current
       FROM academic_sessions
       WHERE school_id = $1 AND is_current = TRUE`,
      [schoolId]
    ),
    pool.query<TermRow>(
      `SELECT t.id, t.session_id, t.school_id, t.name, t.start_date, t.end_date, t.is_current
       FROM terms t
       JOIN academic_sessions s ON s.id = t.session_id
       WHERE t.school_id = $1 AND t.is_current = TRUE AND s.is_current = TRUE`,
      [schoolId]
    ),
  ]);
  return {
    session: sessionResult.rows[0] ?? null,
    term: termResult.rows[0] ?? null,
  };
}
