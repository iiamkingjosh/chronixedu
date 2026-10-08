/**
 * Settings → Users creates staff accounts only (8 Oct 2026). It also made "student" and "parent" accounts:
 * a student that was a login with no student record, so no class and no place on the registrar's list (how
 * King High School Test's first student went missing), and a parent linked to no child, whose password
 * this route returned to the screen after Round 37 had stopped that everywhere else. Students are
 * registered under Students; a parent is added at registration or from the child's profile.
 * Each refusal is shown beside a staff account the same route still creates (doctrine 16).
 */
const mockCreateUser = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: { createUser: (input: unknown) => mockCreateUser(input) } } },
}));

import crypto from 'crypto';
import request from 'supertest';
import { pool, seed, IDS as I, buildApp, tokens } from './helpers';

const A = I.schoolA;
const app = buildApp();
const create = (role: string, email: string) => request(app).post(`/api/schools/${A}/users`)
  .set('Authorization', tokens.principalA()).send({ email, first_name: 'New', last_name: 'Person', role, teacher_mode: role === 'teacher' ? 'class' : undefined });
const usersWithEmail = async (email: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [email])).rows[0].n);

beforeEach(async () => {
  await seed();
  mockCreateUser.mockReset();
  mockCreateUser.mockImplementation(async () => ({ data: { user: { id: crypto.randomUUID() } }, error: null }));
});

afterAll(async () => {
  await pool.end();
});

it('each staff role is still created', async () => {
  for (const role of ['teacher', 'registrar', 'bursar', 'principal']) {
    const email = `${role}-new@example.test`;
    expect({ role, status: (await create(role, email)).status }).toEqual({ role, status: 201 });
    expect(await usersWithEmail(email)).toBe(1);
  }
});

it('a student or parent account is refused before any login is made, and says where they are added', async () => {
  for (const role of ['student', 'parent']) {
    const email = `${role}-new@example.test`;
    const res = await create(role, email);
    expect({ role, status: res.status }).toEqual({ role, status: 400 });
    expect(JSON.stringify(res.body.error.message)).toContain('Students are added under Students');
    expect(await usersWithEmail(email)).toBe(0);
  }
  expect(mockCreateUser).not.toHaveBeenCalled();
});
