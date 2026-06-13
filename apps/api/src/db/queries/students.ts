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
  new_parents: Array<{ email: string; temp_password: string }>;
}

// ── Register (transaction) ─────────────────────────────────────────────────────

export async function registerStudent(
  schoolId: string,
  data: StudentInput & { passwordHash: string },
  parents: Array<ParentInput & { passwordHash: string; tempPassword: string }>
): Promise<RegistrationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const year = new Date().getFullYear();

    // Admission number prefix is configurable per school (school_settings.identity_config.admission_prefix)
    const prefixResult = await client.query<{ admission_prefix: string | null }>(
      `SELECT identity_config->>'admission_prefix' AS admission_prefix FROM school_settings WHERE school_id = $1`,
      [schoolId]
    );
    const prefix = prefixResult.rows[0]?.admission_prefix?.trim() || 'SCH';

    // Generate admission_no — sequence is per school per year, format PREFIX/YEAR/seq
    const seqResult = await client.query<{ next_seq: string }>(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(admission_no FROM '([0-9]{4})$') AS INTEGER)), 0) + 1 AS next_seq
       FROM students
       WHERE school_id = $1 AND admission_no LIKE $2`,
      [schoolId, `${prefix}/${year}/%`]
    );
    const nextSeq = parseInt(seqResult.rows[0].next_seq, 10);
    const admissionNo = `${prefix}/${year}/${String(nextSeq).padStart(4, '0')}`;

    const email = data.email ?? `${admissionNo.toLowerCase().replace(/\//g, '-')}@students.internal`;

    // Create student user account
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, $3, 'student', $4, $5, $6)
       RETURNING id`,
      [schoolId, email, data.passwordHash, data.first_name, data.last_name, data.phone ?? null]
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
    const newParents: Array<{ email: string; temp_password: string }> = [];

    for (const parent of parents) {
      const existingUser = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [parent.email]
      );

      let parentUserId: string;
      if (existingUser.rows.length > 0) {
        parentUserId = existingUser.rows[0].id;
      } else {
        const newUser = await client.query<{ id: string }>(
          `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, phone)
           VALUES ($1, $2, $3, 'parent', $4, $5, $6)
           RETURNING id`,
          [schoolId, parent.email, parent.passwordHash, parent.first_name, parent.last_name, parent.phone ?? null]
        );
        parentUserId = newUser.rows[0].id;
        newParents.push({ email: parent.email, temp_password: parent.tempPassword });
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
      if (sessionId) {
        await client.query(
          `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
          [student.id, data.class_id, sessionId]
        );
        enrollment = { class_id: data.class_id, session_id: sessionId };
      }
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
              sc.session_id, sess.name AS session_name, sc.enrolled_at
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

export async function updateStudentBio(
  studentId: string,
  schoolId: string,
  patch: BioUpdate
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Photo URL ─────────────────────────────────────────────────────────────────

export async function updateStudentPhotoUrl(
  studentId: string,
  schoolId: string,
  photoUrl: string
): Promise<void> {
  await pool.query(
    `UPDATE students SET photo_url = $1 WHERE id = $2 AND school_id = $3`,
    [photoUrl, studentId, schoolId]
  );
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

export async function updateEnrollmentClass(enrollmentId: string, classId: string): Promise<void> {
  await pool.query(`UPDATE student_classes SET class_id = $1 WHERE id = $2`, [classId, enrollmentId]);
}
