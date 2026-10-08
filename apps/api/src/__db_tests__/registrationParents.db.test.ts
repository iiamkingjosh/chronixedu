/**
 * Registration links only a parent of this school (audit, 8 Oct 2026; Moses: one parent account
 * belongs to one school, "No" to sharing across schools).
 *
 * Registration found a parent by email alone. Any account of the school with that email was
 * linked as the child's parent: a teacher's, the bursar's, another student's, so they could read
 * the child's results and fees as a parent would. Another school's parent was refused only by
 * migration 033's trigger, deep inside the transaction, after the student's login had already been
 * created in Supabase: a 500, and a login with no account behind it.
 *
 * Now each parent's email is checked first, before any login is made: an account of another school,
 * or of this school but not a parent, is refused by name, and nothing is created.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { registerStudent, RegistrationRefusal, type CreateAuthAccount } from '../db/queries/students';

const app = buildApp();
const PARENT_B = '30000000-0000-4000-8000-000000000096';

let authCalls: string[];
const createAuthAccount: CreateAuthAccount = async ({ email }) => {
  authCalls.push(email);
  return (await pool.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
};

const student = { first_name: 'Ada', last_name: 'Bello', passwordHash: 'h', tempPassword: 'p' };
const parent = (email: string) => ({
  email, first_name: 'Chidi', last_name: 'Bello', relationship_type: 'father', is_primary_contact: true, passwordHash: 'h', tempPassword: 'p',
});
const studentsNamed = async (last: string) => (await pool.query(
  `SELECT 1 FROM students st JOIN users u ON u.id = st.user_id WHERE u.last_name = $1`, [last])).rowCount;

beforeEach(async () => {
  await seed();
  authCalls = [];
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'parent-b@example.test', 'x', 'parent', 'Pat', 'B', true, 'subject', false)`, [PARENT_B, I.schoolB]);
});
afterAll(() => pool.end());

it("links this school's existing parent, making a login for the student only", async () => {
  const result = await registerStudent(I.schoolA, student, [parent(`${I.parentA}@test`)], createAuthAccount);
  expect(authCalls).toHaveLength(1);
  const links = await pool.query(`SELECT parent_id FROM parent_students WHERE student_id = $1`, [result.student.id]);
  expect(links.rows).toEqual([{ parent_id: I.parentA }]);
});

it('refuses a staff email as a parent, before any login is made', async () => {
  await expect(registerStudent(I.schoolA, student, [parent(`${I.mathTeacher}@test`)], createAuthAccount))
    .rejects.toMatchObject({ code: 'NOT_A_PARENT', status: 409 });
  expect(authCalls).toEqual([]);
  expect(await studentsNamed('Bello')).toBe(0);
});

it("refuses another school's parent, before any login is made", async () => {
  const err = await registerStudent(I.schoolA, student, [parent('parent-b@example.test')], createAuthAccount).catch(e => e);
  expect(err).toBeInstanceOf(RegistrationRefusal);
  expect(err).toMatchObject({ code: 'PARENT_AT_ANOTHER_SCHOOL', status: 409 });
  expect(err.message).toMatch(/another school/);
  expect(authCalls).toEqual([]);
  expect(await studentsNamed('Bello')).toBe(0);
  expect((await pool.query(`SELECT 1 FROM parent_students WHERE parent_id = $1`, [PARENT_B])).rowCount).toBe(0);
});

it('the registration route answers 409 with the reason, not 500', async () => {
  const res = await request(app).post(`/api/schools/${I.schoolA}/students`).set('Authorization', tokens.principalA())
    .send({
      first_name: 'Ada', last_name: 'Bello',
      parents: [{ email: 'parent-b@example.test', email_confirmation: 'parent-b@example.test', first_name: 'Pat', last_name: 'B', relationship_type: 'father', is_primary_contact: true }],
    });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('PARENT_AT_ANOTHER_SCHOOL');
});

describe("the class a student is registered into (audit S1)", () => {
  it("must be one of this school's classes", async () => {
    const otherClass = (await pool.query<{ id: string }>(
      `INSERT INTO classes (school_id, name, level) VALUES ($1, 'B Class', 'Junior') RETURNING id`, [I.schoolB])).rows[0].id;
    await expect(registerStudent(I.schoolA, { ...student, class_id: otherClass }, [], createAuthAccount))
      .rejects.toMatchObject({ code: 'CLASS_NOT_FOUND', status: 404 });
    expect(authCalls).toEqual([]);
    expect(await studentsNamed('Bello')).toBe(0);
  });

  it('is refused, not silently dropped, when the school has no current session', async () => {
    // Control: with a current session, the student is put in the class.
    const placed = await registerStudent(I.schoolA, { ...student, class_id: I.jss2a }, [], createAuthAccount);
    expect(placed.enrollment).toEqual({ class_id: I.jss2a, session_id: I.sessionA });

    await pool.query(`UPDATE academic_sessions SET is_current = false WHERE id = $1`, [I.sessionA]);
    await expect(registerStudent(I.schoolA, { ...student, last_name: 'Okafor', class_id: I.jss2a }, [], createAuthAccount))
      .rejects.toMatchObject({ code: 'NO_CURRENT_SESSION', status: 409 });
    expect(await studentsNamed('Okafor')).toBe(0);
  });
});
