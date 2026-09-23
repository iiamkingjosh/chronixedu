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

/** All terms in a session, earliest first. Used to check a new/edited term's dates
 *  against its siblings — terms must not overlap (see findTermForDate). */
export async function listTermsBySession(sessionId: string, schoolId: string): Promise<TermRow[]> {
  const result = await pool.query<TermRow>(
    `SELECT id, session_id, school_id, name, start_date, end_date, is_current
     FROM terms
     WHERE session_id = $1 AND school_id = $2
     ORDER BY start_date`,
    [sessionId, schoolId]
  );
  return result.rows;
}

/**
 * Updates a term's name and/or dates. School calendars shift after onboarding
 * (holidays, strikes, elections), and before this existed the only way to correct a
 * term was direct database access. is_current is deliberately NOT editable here —
 * use activateTerm, which maintains the one-current-term-per-session invariant.
 */
export async function updateTerm(
  termId: string,
  sessionId: string,
  schoolId: string,
  patch: { name?: string; start_date?: string; end_date?: string }
): Promise<TermRow | null> {
  // Column names are taken from this fixed allowlist, never from the caller's object
  // keys — see SECURITY.md Round 5 M-07 (dynamic SQL column names from Zod fields).
  const COLUMNS = ['name', 'start_date', 'end_date'] as const;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const column of COLUMNS) {
    const value = patch[column];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findTermById(termId, sessionId, schoolId);

  params.push(termId, sessionId, schoolId);
  const result = await pool.query<TermRow>(
    `UPDATE terms SET ${sets.join(', ')}
     WHERE id = $${params.length - 2} AND session_id = $${params.length - 1} AND school_id = $${params.length}
     RETURNING id, session_id, school_id, name, start_date, end_date, is_current`,
    params
  );
  return result.rows[0] ?? null;
}

export async function findTermById(
  termId: string,
  sessionId: string,
  schoolId: string
): Promise<TermRow | null> {
  const result = await pool.query<TermRow>(
    `SELECT id, session_id, school_id, name, start_date, end_date, is_current
     FROM terms
     WHERE id = $1 AND session_id = $2 AND school_id = $3`,
    [termId, sessionId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function activateTerm(schoolId: string, sessionId: string, termId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear any existing current term within this session
    await client.query(
      `UPDATE terms SET is_current = FALSE WHERE session_id = $1 AND school_id = $2 AND is_current = TRUE`,
      [sessionId, schoolId]
    );
    // Set the target term as current — partial unique index enforces one-current-per-session at DB level
    await client.query(
      `UPDATE terms SET is_current = TRUE WHERE id = $1 AND session_id = $2 AND school_id = $3`,
      [termId, sessionId, schoolId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
