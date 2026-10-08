import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StudentRow {
  id: string;
  school_id: string;
  user_id: string;
  admission_no: string;
  dob: string | null;
  gender: string | null;
  address: string | null;
  photo_url: string | null;
  blood_group: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

export interface StudentListRow extends StudentRow {
  first_name: string;
  last_name: string;
  email: string;
  class_id: string | null;
  class_name: string | null;
  class_level: string | null;
}

export interface ClassEnrollment {
  id: string;
  class_id: string;
  class_name: string;
  class_level: string;
  class_stream: string | null;
  session_id: string;
  session_name: string;
  /** Whether this enrolment is in the school's current session: the one a class is assigned or corrected in. */
  session_is_current: boolean;
  enrolled_at: string;
}

export interface LinkedParent {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  relationship_type: string;
  is_primary_contact: boolean;
}

export interface StudentProfile extends StudentRow {
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  enrollments: ClassEnrollment[];
  parents: LinkedParent[];
}

export interface ParentInput {
  email: string;
  first_name: string;
  last_name: string;
  phone?: string;
  relationship_type: string;
  is_primary_contact: boolean;
}

export interface StudentInput {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  dob?: string | null;
  gender?: string | null;
  address?: string | null;
  blood_group?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  class_id?: string | null;
}

export interface RegistrationResult {
  student: StudentRow & { first_name: string; last_name: string; email: string };
  admission_no: string;
  temp_password: string;
  enrollment: { class_id: string; session_id: string } | null;
  new_parents: Array<{ user_id: string; email: string; temp_password: string }>;
}

/**
 * Creates the Supabase Auth identity for one account and returns its id, which
 * becomes `users.id`. Injected rather than imported so this query module stays free
 * of Supabase (routes orchestrate, queries do DB access).
 *
 * Login goes through supabase.auth.signInWithPassword and then looks the local row
 * up by the returned auth id — `users.password_hash` is only ever read to verify the
 * CURRENT password during a change (routes/auth.ts). So a users row with no matching
 * auth identity is an account that can never log in. Before this existed,
 * registerStudent created exactly that for the student and for every new parent, and
 * the route then emailed those parents a welcome message containing a password that
 * could not work.
 */
export type CreateAuthAccount = (input: {
  email: string;
  password: string;
  role: 'student' | 'parent';
  first_name: string;
  last_name: string;
}) => Promise<string>;

// ── Who may be linked as a parent ─────────────────────────────────────────────

/** A refusal that names its reason, for the route to answer with `status` instead of a 500. */
export class RegistrationRefusal extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = 'RegistrationRefusal';
  }
}

/**
 * Checks each parent's email before anything is created (audit, 8 Oct 2026). An existing account
 * with the email is linked as the parent only if it is a parent of this school: one parent account
 * belongs to one school (Moses, 8 Oct 2026), and a staff or student account is never made someone's
 * parent. Registration linked any account with the email; another school's parent was then refused
 * by migration 033's trigger, after the student's login had been made: a 500 and a stray login.
 */
export async function refuseUnlinkableParents(schoolId: string, emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  const { rows } = await pool.query<{ email: string; school_id: string | null; role: string }>(
    `SELECT email, school_id, role FROM users WHERE lower(email) = ANY($1::text[])`,
    [emails.map(e => e.trim().toLowerCase())]
  );
  for (const account of rows) {
    if (account.school_id !== schoolId) {
      throw account.role === 'parent'
        ? new RegistrationRefusal('PARENT_AT_ANOTHER_SCHOOL',
            `${account.email} belongs to a parent account at another school. A parent account belongs to one school, so give this parent a different email here.`)
        : new RegistrationRefusal('EMAIL_IN_USE',
            `${account.email} is already used by an account at another school. Give this parent a different email.`);
    }
    if (account.role !== 'parent') {
      throw new RegistrationRefusal('NOT_A_PARENT',
        `${account.email} belongs to a ${account.role.replace('_', ' ')} account at this school. A parent needs an email of their own.`);
    }
  }
}

// ── Register (transaction) ─────────────────────────────────────────────────────

export async function registerStudent(
  schoolId: string,
  data: StudentInput & { passwordHash: string; tempPassword: string },
  parents: Array<ParentInput & { passwordHash: string; tempPassword: string }>,
  createAuthAccount: CreateAuthAccount
): Promise<RegistrationResult> {
  // Before any login is made, so a refusal leaves nothing behind.
  await refuseUnlinkableParents(schoolId, parents.map(p => p.email));
  if (data.class_id) {
    // The class is checked against the school (doctrine 3), and a class asked for is never dropped:
    // with no current session the student used to be registered without one, and nobody was told.
    const { rows: [check] } = await pool.query<{ class_ok: boolean; session_id: string | null }>(
      `SELECT EXISTS (SELECT 1 FROM classes WHERE id = $1 AND school_id = $2) AS class_ok,
              (SELECT id FROM academic_sessions WHERE school_id = $2 AND is_current) AS session_id`,
      [data.class_id, schoolId]
    );
    if (!check.class_ok) {
      throw new RegistrationRefusal('CLASS_NOT_FOUND', "That class is not one of this school's classes.", 404);
    }
    if (!check.session_id) {
      throw new RegistrationRefusal('NO_CURRENT_SESSION',
        'This school has no current session, so the student cannot be put in a class yet. Make a session current in Settings → Academic Structure, or register the student without a class and use Assign Class later.');
    }
  }

  // ── Phase 1: resolve identifiers and create auth accounts OUTSIDE the transaction.
  // users.ts:594-603 documents why the auth call must not sit inside one: an external
  // API call in a transaction orphans the remote account whenever the DB later rolls
  // back. The same accepted trade-off applies here — a failure after createAuthAccount
  // leaves an orphaned Supabase identity, which is recoverable; the reverse (a local
  // row with no identity) is the bug being fixed and is not.
  const prefixResult = await pool.query<{ admission_prefix: string | null }>(
    `SELECT identity_config->>'admission_prefix' AS admission_prefix FROM school_settings WHERE school_id = $1`,
    [schoolId]
  );
  const prefixEarly = prefixResult.rows[0]?.admission_prefix?.trim() || 'SCH';
  const yearEarly = new Date().getFullYear();
  const seqEarly = await pool.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(admission_no FROM '([0-9]{4})$') AS INTEGER)), 0) + 1 AS next_seq
     FROM students WHERE school_id = $1 AND admission_no LIKE $2`,
    [schoolId, `${prefixEarly}/${yearEarly}/%`]
  );
  // Reserved, not locked: a concurrent registration taking the same number is caught
  // by UNIQUE(school_id, admission_no) and surfaces as 409 DUPLICATE in the route.
  const reservedAdmissionNo = `${prefixEarly}/${yearEarly}/${String(parseInt(seqEarly.rows[0].next_seq, 10)).padStart(4, '0')}`;
  const studentEmail = data.email ?? `${reservedAdmissionNo.toLowerCase().replace(/\//g, '-')}@students.internal`;

  const studentAuthId = await createAuthAccount({
    email: studentEmail,
    password: data.tempPassword,
    role: 'student',
    first_name: data.first_name,
    last_name: data.last_name,
  });

  // Only parents without an existing account need an identity created.
  const parentAuthIds = new Map<string, string>();
  for (const parent of parents) {
    const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [parent.email]);
    if (existing.rows.length > 0) continue;
    parentAuthIds.set(
      parent.email,
      await createAuthAccount({
        email: parent.email,
        password: parent.tempPassword,
        role: 'parent',
        first_name: parent.first_name,
        last_name: parent.last_name,
      })
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reserved in phase 1, so the auth identity and this row agree on the number and
    // the derived email. A concurrent registration that took it first trips
    // UNIQUE(school_id, admission_no) below and surfaces as 409 DUPLICATE.
    const admissionNo = reservedAdmissionNo;
    const email = studentEmail;

    // users.id MUST equal the Supabase Auth id — login resolves the local row by the
    // id signInWithPassword returns, so a mismatch is as unusable as a missing row.
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, 'student', $5, $6, $7)
       RETURNING id`,
      [studentAuthId, schoolId, email, data.passwordHash, data.first_name, data.last_name, data.phone ?? null]
    );
    const userId = userResult.rows[0].id;

    // Insert student record
    const studentResult = await client.query<StudentRow>(
      `INSERT INTO students
         (school_id, user_id, admission_no, dob, gender, address, blood_group, emergency_contact_name, emergency_contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, school_id, user_id, admission_no, dob, gender, address, photo_url,
                 blood_group, emergency_contact_name, emergency_contact_phone`,
      [
        schoolId, userId, admissionNo,
        data.dob ?? null, data.gender ?? null, data.address ?? null,
        data.blood_group ?? null, data.emergency_contact_name ?? null, data.emergency_contact_phone ?? null,
      ]
    );
    const student = studentResult.rows[0];

    // Handle parents — find existing account by email or create new
    const newParents: Array<{ user_id: string; email: string; temp_password: string }> = [];

    for (const parent of parents) {
      const existingUser = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [parent.email]
      );

      let parentUserId: string;
      if (existingUser.rows.length > 0) {
        parentUserId = existingUser.rows[0].id;
      } else {
        const authId = parentAuthIds.get(parent.email);
        if (!authId) {
          // Phase 1 saw this email as already taken but the row is gone now — bail
          // rather than create a parent who cannot log in.
          throw new Error(`No auth identity was created for parent ${parent.email}`);
        }
        const newUser = await client.query<{ id: string }>(
          `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, phone)
           VALUES ($1, $2, $3, $4, 'parent', $5, $6, $7)
           RETURNING id`,
          [authId, schoolId, parent.email, parent.passwordHash, parent.first_name, parent.last_name, parent.phone ?? null]
        );
        parentUserId = newUser.rows[0].id;
        newParents.push({ user_id: parentUserId, email: parent.email, temp_password: parent.tempPassword });
      }

      await client.query(
        `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
         VALUES ($1, $2, $3, $4)`,
        [parentUserId, student.id, parent.relationship_type, parent.is_primary_contact]
      );
    }

    // Enroll in class if class_id provided — use current session
    let enrollment: { class_id: string; session_id: string } | null = null;
    if (data.class_id) {
      const sessionResult = await client.query<{ id: string }>(
        `SELECT id FROM academic_sessions WHERE school_id = $1 AND is_current = TRUE`,
        [schoolId]
      );
      const sessionId = sessionResult.rows[0]?.id;
      if (!sessionId) {
        // Checked before anything was made; a session switched off since then fails the registration.
        throw new RegistrationRefusal('NO_CURRENT_SESSION', 'The school has no current session any more. Register the student again.');
      }
      await client.query(
        `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
        [student.id, data.class_id, sessionId]
      );
      enrollment = { class_id: data.class_id, session_id: sessionId };
    }

    await client.query('COMMIT');

    return {
      student: { ...student, first_name: data.first_name, last_name: data.last_name, email },
      admission_no: admissionNo,
      temp_password: data.passwordHash, // route layer passes plaintext — see below
      enrollment,
      new_parents: newParents,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── List (paginated + filtered) ────────────────────────────────────────────────

export interface ListStudentsOptions {
  page: number;
  limit: number;
  classId?: string;
  sessionId?: string;
  search?: string;
}

export async function listStudents(
  schoolId: string,
  opts: ListStudentsOptions
): Promise<{ students: StudentListRow[]; total: number; page: number; limit: number }> {
  const params: unknown[] = [schoolId];
  const whereExtra: string[] = [];

  // Build the student_classes join condition
  let sessionCondition: string;
  if (opts.sessionId) {
    params.push(opts.sessionId);
    sessionCondition = `sc.session_id = $${params.length}`;
  } else {
    sessionCondition = `sc.session_id = (SELECT id FROM academic_sessions WHERE school_id = $1 AND is_current = TRUE)`;
  }

  if (opts.classId) {
    params.push(opts.classId);
    whereExtra.push(`sc.class_id = $${params.length}`);
  }
  // A session named by the caller lists that session's students, and only them. It listed every
  // student of the school, so the Promotion Manager offered children never in the session (audit,
  // 8 Oct 2026). With no session named, the list still shows students without a class this session.
  if (opts.sessionId) {
    whereExtra.push('sc.id IS NOT NULL');
  }

  if (opts.search) {
    params.push(`%${opts.search}%`);
    const n = params.length;
    whereExtra.push(
      `(u.first_name ILIKE $${n} OR u.last_name ILIKE $${n} OR (u.first_name || ' ' || u.last_name) ILIKE $${n} OR s.admission_no ILIKE $${n})`
    );
  }

  const extraWhere = whereExtra.length > 0 ? ' AND ' + whereExtra.join(' AND ') : '';

  const baseFrom = `
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN student_classes sc ON sc.student_id = s.id AND ${sessionCondition}
    LEFT JOIN classes c ON c.id = sc.class_id
    WHERE s.school_id = $1${extraWhere}`;

  const countParams = [...params];
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count ${baseFrom}`,
    countParams
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  params.push(opts.limit);
  const limitParam = params.length;
  params.push((opts.page - 1) * opts.limit);
  const offsetParam = params.length;

  const studentsResult = await pool.query<StudentListRow>(
    `SELECT
       s.id, s.school_id, s.user_id, s.admission_no, s.dob, s.gender,
       s.address, s.photo_url, s.blood_group, s.emergency_contact_name, s.emergency_contact_phone,
       u.first_name, u.last_name, u.email,
       c.id    AS class_id,
       c.name  AS class_name,
       c.level AS class_level
     ${baseFrom}
     ORDER BY u.last_name, u.first_name
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  );

  return { students: studentsResult.rows, total, page: opts.page, limit: opts.limit };
}

// ── Full profile ───────────────────────────────────────────────────────────────

export async function getStudentProfile(
  studentId: string,
  schoolId: string
): Promise<StudentProfile | null> {
  const [studentResult, enrollmentResult, parentsResult] = await Promise.all([
    pool.query<StudentRow & { first_name: string; last_name: string; email: string; phone: string | null }>(
      `SELECT s.id, s.school_id, s.user_id, s.admission_no, s.dob, s.gender, s.address,
              s.photo_url, s.blood_group, s.emergency_contact_name, s.emergency_contact_phone,
              u.first_name, u.last_name, u.email, u.phone
       FROM students s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.school_id = $2`,
      [studentId, schoolId]
    ),
    pool.query<ClassEnrollment>(
      `SELECT sc.id, sc.class_id, c.name AS class_name, c.level AS class_level, c.stream AS class_stream,
              sc.session_id, sess.name AS session_name, sess.is_current AS session_is_current, sc.enrolled_at
       FROM student_classes sc
       JOIN classes c ON c.id = sc.class_id
       JOIN academic_sessions sess ON sess.id = sc.session_id
       WHERE sc.student_id = $1
       ORDER BY sess.start_date DESC`,
      [studentId]
    ),
    pool.query<LinkedParent>(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
              ps.relationship_type, ps.is_primary_contact
       FROM parent_students ps JOIN users u ON u.id = ps.parent_id
       WHERE ps.student_id = $1`,
      [studentId]
    ),
  ]);

  const student = studentResult.rows[0];
  if (!student) return null;

  return {
    ...student,
    enrollments: enrollmentResult.rows,
    parents: parentsResult.rows,
  };
}

// ── Update bio ─────────────────────────────────────────────────────────────────

export interface BioUpdate {
  first_name?: string;
  last_name?: string;
  phone?: string;
  dob?: string | null;
  gender?: string | null;
  address?: string | null;
  blood_group?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
}

/** Updates a student's details; returns the values the patched fields held before, read under the
 *  same row locks as the write, for the audit row (doctrine 10: an old value is read, never assumed). */
export async function updateStudentBio(
  studentId: string,
  schoolId: string,
  patch: BioUpdate
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [before] } = await client.query<Record<string, unknown>>(
      `SELECT s.dob::text AS dob, s.gender, s.address, s.blood_group, s.emergency_contact_name, s.emergency_contact_phone,
              u.first_name, u.last_name, u.phone
         FROM students s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.school_id = $2
        FOR UPDATE OF s, u`,
      [studentId, schoolId]
    );
    const prior: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      if (before && key in before) prior[key] = before[key];
    }

    const studentFields: string[] = [];
    const studentParams: unknown[] = [studentId, schoolId];

    const studentCols = ['dob', 'gender', 'address', 'blood_group', 'emergency_contact_name', 'emergency_contact_phone'] as const;
    for (const col of studentCols) {
      if (col in patch) {
        studentParams.push(patch[col] ?? null);
        studentFields.push(`${col} = $${studentParams.length}`);
      }
    }

    if (studentFields.length > 0) {
      await client.query(
        `UPDATE students SET ${studentFields.join(', ')} WHERE id = $1 AND school_id = $2`,
        studentParams
      );
    }

    const userFields: string[] = [];
    const userParams: unknown[] = [studentId];

    if (patch.first_name) { userParams.push(patch.first_name); userFields.push(`first_name = $${userParams.length}`); }
    if (patch.last_name)  { userParams.push(patch.last_name);  userFields.push(`last_name  = $${userParams.length}`); }
    if ('phone' in patch) { userParams.push(patch.phone ?? null); userFields.push(`phone = $${userParams.length}`); }

    if (userFields.length > 0) {
      await client.query(
        `UPDATE users SET ${userFields.join(', ')}
         WHERE id = (SELECT user_id FROM students WHERE id = $1)`,
        userParams
      );
    }

    await client.query('COMMIT');
    return prior;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Photo URL ─────────────────────────────────────────────────────────────────

/** Stores the photo's path; returns the path it replaced (null if none), for the audit row. */
export async function updateStudentPhotoUrl(
  studentId: string,
  schoolId: string,
  photoUrl: string
): Promise<string | null> {
  const { rows } = await pool.query<{ prior: string | null }>(
    `WITH old AS (SELECT photo_url FROM students WHERE id = $2 AND school_id = $3 FOR UPDATE)
     UPDATE students SET photo_url = $1 WHERE id = $2 AND school_id = $3
     RETURNING (SELECT photo_url FROM old) AS prior`,
    [photoUrl, studentId, schoolId]
  );
  return rows[0]?.prior ?? null;
}

// ── Promote ───────────────────────────────────────────────────────────────────

export interface StudentClassRow {
  id: string;
  student_id: string;
  class_id: string;
  session_id: string;
  enrolled_at: string;
}

export async function findStudentById(
  studentId: string,
  schoolId: string
): Promise<StudentRow | null> {
  const result = await pool.query<StudentRow>(
    `SELECT id, school_id, user_id, admission_no FROM students WHERE id = $1 AND school_id = $2`,
    [studentId, schoolId]
  );
  return result.rows[0] ?? null;
}

/** Resolve a student's own record from their `users.id` (JWT user_id) — for self-service portals. */
export async function findStudentByUserId(
  userId: string,
  schoolId: string
): Promise<StudentRow | null> {
  const result = await pool.query<StudentRow>(
    `SELECT id, school_id, user_id, admission_no, dob, gender, address, photo_url,
            blood_group, emergency_contact_name, emergency_contact_phone
     FROM students WHERE user_id = $1 AND school_id = $2`,
    [userId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function findEnrollmentForSession(
  studentId: string,
  sessionId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM student_classes WHERE student_id = $1 AND session_id = $2`,
    [studentId, sessionId]
  );
  return result.rows.length > 0;
}

export async function insertStudentClass(
  studentId: string,
  classId: string,
  sessionId: string
): Promise<StudentClassRow> {
  const result = await pool.query<StudentClassRow>(
    `INSERT INTO student_classes (student_id, class_id, session_id)
     VALUES ($1, $2, $3)
     RETURNING id, student_id, class_id, session_id, enrolled_at`,
    [studentId, classId, sessionId]
  );
  return result.rows[0];
}

// ── Intra-session class correction ─────────────────────────────────────────────

export async function findEnrollmentForCurrentSession(
  studentId: string,
  schoolId: string
): Promise<StudentClassRow | null> {
  const result = await pool.query<StudentClassRow>(
    `SELECT sc.id, sc.student_id, sc.class_id, sc.session_id, sc.enrolled_at
     FROM student_classes sc
     JOIN students s ON s.id = sc.student_id
     WHERE sc.student_id = $1
       AND s.school_id = $2
       AND sc.session_id = (SELECT id FROM academic_sessions WHERE school_id = $2 AND is_current = TRUE)`,
    [studentId, schoolId]
  );
  return result.rows[0] ?? null;
}

export type AssignClassOutcome =
  | { outcome: 'assigned'; enrollment: StudentClassRow }
  | { outcome: 'student_not_found' | 'class_not_found' | 'no_current_session' }
  | { outcome: 'already_enrolled'; classId: string };

/**
 * Puts a student who has no class this session into one (8 Oct 2026). Registration takes a class only
 * optionally and says one can be given later, but the only class route was a correction, which needs
 * an existing enrolment: a student registered without a class could never get one.
 *
 * One transaction with the student's row locked, because student_classes has no unique constraint on
 * (student_id, session_id): two assignments at once would otherwise both see "no class" and enrol the
 * student twice. The enrolment trigger reprices the school's subscription (migration 045).
 */
export async function assignClassForCurrentSession(
  studentId: string,
  schoolId: string,
  classId: string
): Promise<AssignClassOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const student = await client.query(
      `SELECT id FROM students WHERE id = $1 AND school_id = $2 FOR UPDATE`,
      [studentId, schoolId]
    );
    if (student.rows.length === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'student_not_found' };
    }
    const cls = await client.query(`SELECT id FROM classes WHERE id = $1 AND school_id = $2`, [classId, schoolId]);
    if (cls.rows.length === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'class_not_found' };
    }
    const session = await client.query<{ id: string }>(
      `SELECT id FROM academic_sessions WHERE school_id = $1 AND is_current = TRUE`,
      [schoolId]
    );
    if (session.rows.length === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'no_current_session' };
    }
    const existing = await client.query<{ class_id: string }>(
      `SELECT class_id FROM student_classes WHERE student_id = $1 AND session_id = $2 LIMIT 1`,
      [studentId, session.rows[0].id]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { outcome: 'already_enrolled', classId: existing.rows[0].class_id };
    }
    const enrollment = await client.query<StudentClassRow>(
      `INSERT INTO student_classes (student_id, class_id, session_id)
       VALUES ($1, $2, $3)
       RETURNING id, student_id, class_id, session_id, enrolled_at`,
      [studentId, classId, session.rows[0].id]
    );
    await client.query('COMMIT');
    return { outcome: 'assigned', enrollment: enrollment.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // silent-ok: the original error is rethrown next
    throw err;
  } finally {
    client.release();
  }
}

export async function updateEnrollmentClass(enrollmentId: string, classId: string): Promise<void> {
  await pool.query(`UPDATE student_classes SET class_id = $1 WHERE id = $2`, [classId, enrollmentId]);
}

// ── Bulk import support ──────────────────────────────────────────────────────

/** Maps each already-registered email (lowercased) to its role, for the
 *  subset of the given emails that exist in `users`. Platform-wide, not
 *  school-scoped — `users.email` has a global UNIQUE constraint. */
export async function findUsersRolesByEmails(emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const result = await pool.query<{ email: string; role: string }>(
    `SELECT email, role FROM users WHERE LOWER(email) = ANY($1::text[])`,
    [emails.map(e => e.toLowerCase())]
  );
  return new Map(result.rows.map(r => [r.email.toLowerCase(), r.role]));
}

/** Which of these emails (lower-cased) belong to an account of a school other than this one. */
export async function findEmailsAtOtherSchools(emails: string[], schoolId: string): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const result = await pool.query<{ email: string }>(
    `SELECT email FROM users WHERE LOWER(email) = ANY($1::text[]) AND school_id IS DISTINCT FROM $2`,
    [emails.map(e => e.toLowerCase()), schoolId]
  );
  return new Set(result.rows.map(r => r.email.toLowerCase()));
}

export type PromotionOutcome = { status: 'enrolled' } | { status: 'skipped'; reason: string };

/**
 * Enrols one student in the next session, as promoted or repeating, in its own transaction with the
 * student's row locked: two runs at once could both find the student not yet enrolled and enrol
 * them twice, since student_classes has no unique (student, session). The student must be in the
 * session being promoted from, and a promotion must name a different class from the one they are in
 * (audit, 8 Oct 2026: "Promoted" beside the current class enrolled them in the same class again).
 */
export async function promoteStudent(
  schoolId: string,
  studentId: string,
  fromSessionId: string,
  toSessionId: string,
  classId: string,
  decision: 'promoted' | 'repeat'
): Promise<PromotionOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const student = await client.query(`SELECT id FROM students WHERE id = $1 AND school_id = $2 FOR UPDATE`, [studentId, schoolId]);
    if (!student.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'Student not found' };
    }
    const from = await client.query<{ class_id: string }>(
      `SELECT class_id FROM student_classes WHERE student_id = $1 AND session_id = $2 ORDER BY enrolled_at DESC LIMIT 1`,
      [studentId, fromSessionId]);
    if (!from.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'Not in the session being promoted from' };
    }
    const already = await client.query(`SELECT 1 FROM student_classes WHERE student_id = $1 AND session_id = $2`, [studentId, toSessionId]);
    if (already.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'Already enrolled for target session' };
    }
    if (decision === 'promoted' && from.rows[0].class_id === classId) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'Marked promoted, but into the same class they are in. Choose the class they move up to, or mark them as repeating.' };
    }
    await client.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [studentId, classId, toSessionId]);
    await client.query('COMMIT');
    return { status: 'enrolled' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Bulk payment import support ─────────────────────────────────────────────

/** Maps each matched Admission Number to the student's id and name, for the
 *  subset of the given admission numbers that resolve to an active student in
 *  this school. Exact-match, not case-normalized — admission numbers are
 *  school-assigned codes (e.g. "SCH/2024/0001"), not free-text names. */
export async function findStudentsByAdmissionNumbers(
  schoolId: string,
  admissionNumbers: string[]
): Promise<Map<string, { id: string; first_name: string; last_name: string }>> {
  if (admissionNumbers.length === 0) return new Map();
  const result = await pool.query<{ admission_no: string; id: string; first_name: string; last_name: string }>(
    `SELECT s.admission_no, s.id, u.first_name, u.last_name
     FROM students s
     JOIN users u ON u.id = s.user_id
     WHERE s.school_id = $1 AND u.is_active = TRUE AND s.admission_no = ANY($2::text[])`,
    [schoolId, admissionNumbers]
  );
  return new Map(result.rows.map(r => [r.admission_no, { id: r.id, first_name: r.first_name, last_name: r.last_name }]));
}
