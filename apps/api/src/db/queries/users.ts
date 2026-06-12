import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  school_id: string | null;
  email: string;
  role: string;
  first_name: string;
  last_name: string;
  title: string | null;
  teacher_mode: 'class' | 'subject';
  phone: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

const USER_COLUMNS = `
  id, school_id, email, role, first_name, last_name, title, teacher_mode,
  phone, is_active, last_login_at, created_at`;

// ── List (paginated + filtered) ────────────────────────────────────────────────

export interface ListUsersOptions {
  page: number;
  limit: number;
  role?: string;
  search?: string;
}

export async function listUsers(
  schoolId: string,
  opts: ListUsersOptions
): Promise<{ users: UserRow[]; total: number; page: number; limit: number }> {
  const params: unknown[] = [schoolId];
  const whereExtra: string[] = [];

  if (opts.role) {
    params.push(opts.role);
    whereExtra.push(`role = $${params.length}`);
  }

  if (opts.search) {
    params.push(`%${opts.search}%`);
    const n = params.length;
    whereExtra.push(
      `(first_name ILIKE $${n} OR last_name ILIKE $${n} OR (first_name || ' ' || last_name) ILIKE $${n} OR email ILIKE $${n})`
    );
  }

  const extraWhere = whereExtra.length > 0 ? ' AND ' + whereExtra.join(' AND ') : '';
  const baseFrom = `FROM users WHERE school_id = $1${extraWhere}`;

  const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count ${baseFrom}`, params);
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  params.push(opts.limit);
  const limitParam = params.length;
  params.push((opts.page - 1) * opts.limit);
  const offsetParam = params.length;

  const result = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS}
     ${baseFrom}
     ORDER BY last_name, first_name
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  );

  return { users: result.rows, total, page: opts.page, limit: opts.limit };
}

// ── Lookups ────────────────────────────────────────────────────────────────────

export async function findUserById(userId: string, schoolId: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND school_id = $2`,
    [userId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function updatePasswordHash(email: string, passwordHash: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE email = $2`,
    [passwordHash, email]
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Create ─────────────────────────────────────────────────────────────────────

export interface NewUserInput {
  email: string;
  passwordHash: string;
  role: string;
  first_name: string;
  last_name: string;
  title: string | null;
  teacher_mode: 'class' | 'subject';
  phone: string | null;
}

export async function insertUser(userId: string, schoolId: string, data: NewUserInput): Promise<UserRow> {
  const result = await pool.query<UserRow>(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, teacher_mode, phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${USER_COLUMNS}`,
    [userId, schoolId, data.email, data.passwordHash, data.role, data.first_name, data.last_name, data.title, data.teacher_mode, data.phone]
  );
  return result.rows[0];
}

// ── Update profile (name, phone, title — never role/teacher_mode) ──────────────

export interface UserProfilePatch {
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  title?: string | null;
}

export async function updateUserProfile(userId: string, schoolId: string, patch: UserProfilePatch): Promise<UserRow> {
  const fields: string[] = [];
  const params: unknown[] = [userId, schoolId];

  if (patch.first_name !== undefined) { params.push(patch.first_name); fields.push(`first_name = $${params.length}`); }
  if (patch.last_name !== undefined)  { params.push(patch.last_name);  fields.push(`last_name = $${params.length}`); }
  if (patch.phone !== undefined)      { params.push(patch.phone);      fields.push(`phone = $${params.length}`); }
  if (patch.title !== undefined)      { params.push(patch.title);      fields.push(`title = $${params.length}`); }

  const result = await pool.query<UserRow>(
    `UPDATE users SET ${fields.join(', ')}
     WHERE id = $1 AND school_id = $2
     RETURNING ${USER_COLUMNS}`,
    params
  );
  return result.rows[0];
}

// ── Activate / deactivate ──────────────────────────────────────────────────────

export async function setUserActive(userId: string, schoolId: string, isActive: boolean): Promise<UserRow> {
  const result = await pool.query<UserRow>(
    `UPDATE users SET is_active = $3
     WHERE id = $1 AND school_id = $2
     RETURNING ${USER_COLUMNS}`,
    [userId, schoolId, isActive]
  );
  return result.rows[0];
}
