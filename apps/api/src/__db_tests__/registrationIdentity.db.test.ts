/**
 * Registration identity regression.
 *
 * Login is `supabase.auth.signInWithPassword` followed by a lookup of the local
 * `users` row BY THE AUTH ID that call returns. `users.password_hash` is only ever
 * read to verify a change-password request. So a `users` row whose id is not the id
 * of a real Supabase Auth account can never be logged into, no matter what password
 * was set on it.
 *
 * registerStudent used to let Postgres generate `users.id`, creating exactly that for
 * the student and for every newly created parent — and the route then emailed those
 * parents a welcome message with credentials that could not work.
 *
 * These tests stand in an `auth.users` table for the Supabase side and assert the
 * join holds for the student AND every parent. On the old code the join is empty.
 */
import { seed, IDS as I, pool } from './helpers';
import { registerStudent, type CreateAuthAccount } from '../db/queries/students';

/** Stand-in for the Supabase-managed `auth.users` table. */
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS auth`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL)`
  );
});
beforeEach(async () => {
  await seed();
  await pool.query(`DELETE FROM auth.users`);
});
afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS auth.users`);
  await pool.end();
});

/** Records the identity it issues, exactly as Supabase would. */
const createAuthAccount: CreateAuthAccount = async ({ email }) => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [email]
  );
  return rows[0].id;
};

const student = {
  first_name: 'Ada',
  last_name: 'Nwosu',
  passwordHash: 'hash-student',
  tempPassword: 'pw-student',
};

function parent(email: string) {
  return {
    email,
    first_name: 'Chidi',
    last_name: 'Nwosu',
    relationship_type: 'father',
    is_primary_contact: true,
    passwordHash: `hash-${email}`,
    tempPassword: `pw-${email}`,
  };
}

/** Every users row for these ids that has no auth identity. */
async function orphanedLogins(userIds: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT u.email FROM users u
       LEFT JOIN auth.users a ON a.id = u.id
      WHERE u.id = ANY($1::uuid[]) AND a.id IS NULL`,
    [userIds]
  );
  return rows.map(r => r.email);
}

describe('registerStudent — auth identity binding', () => {
  it('gives the student a users.id that is a real auth identity', async () => {
    const result = await registerStudent(I.schoolA, student, [], createAuthAccount);

    expect(await orphanedLogins([result.student.user_id])).toEqual([]);
  });

  it('gives every newly created parent a users.id that is a real auth identity', async () => {
    const result = await registerStudent(
      I.schoolA,
      student,
      [parent('dad@example.com'), { ...parent('mum@example.com'), is_primary_contact: false }],
      createAuthAccount
    );

    expect(result.new_parents.map(p => p.email).sort()).toEqual([
      'dad@example.com',
      'mum@example.com',
    ]);

    const { rows } = await pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM parent_students WHERE student_id = $1`,
      [result.student.id]
    );
    expect(rows).toHaveLength(2);
    expect(await orphanedLogins(rows.map(r => r.parent_id))).toEqual([]);
  });

  it('reuses an existing parent account instead of issuing a second identity', async () => {
    await registerStudent(I.schoolA, student, [parent('dad@example.com')], createAuthAccount);
    const before = await pool.query(`SELECT count(*)::int AS n FROM auth.users`);

    const second = await registerStudent(
      I.schoolA,
      { ...student, first_name: 'Ifeanyi' },
      [parent('dad@example.com')],
      createAuthAccount
    );

    // One new identity for the second student, none for the parent already on file.
    const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth.users`);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    expect(second.new_parents).toEqual([]);

    const { rows } = await pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM parent_students WHERE student_id = $1`,
      [second.student.id]
    );
    expect(await orphanedLogins(rows.map(r => r.parent_id))).toEqual([]);
  });

  it('does not leave a half-registered student when a parent identity cannot be issued', async () => {
    const failing: CreateAuthAccount = async input => {
      if (input.role === 'parent') throw new Error('supabase down');
      return createAuthAccount(input);
    };

    await expect(
      registerStudent(I.schoolA, student, [parent('dad@example.com')], failing)
    ).rejects.toThrow('supabase down');

    const { rows } = await pool.query(
      `SELECT 1 FROM users WHERE school_id = $1 AND role = 'student' AND first_name = 'Ada'`,
      [I.schoolA]
    );
    expect(rows).toHaveLength(0);
  });
});
