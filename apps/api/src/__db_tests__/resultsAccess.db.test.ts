/**
 * Scores, results and the teacher's workspace read the table (Batch 9, task 6; Moses, 8 Oct 2026).
 *
 * - A teacher's pending scores are read by the teacher themselves and by the principal (decision 4). Any other
 *   member could call the route and was answered with an empty list.
 * - The teacher's own dashboard is the teacher's: a platform admin reaches a school as one of its users through a
 *   support session, never as itself (decision 7). It used to admit the platform admin.
 */
import request from 'supertest';
import { buildApp, seed, token, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const ADMIN = 'c0000000-0000-4000-8000-000000000061';

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'admin@results.test', 'x', 'super_admin', 'Plat', 'Form', false, false)`, [ADMIN]);
});
afterAll(() => pool.end());

describe("a teacher's pending scores", () => {
  const pending = (auth: string, teacherId?: string) =>
    request(app).get(`${base}/scores/my-pending`).set('Authorization', auth).query(teacherId ? { teacher_id: teacherId } : {});

  it('are read by the teacher and by the principal, and by nobody else', async () => {
    expect((await pending(tokens.math())).status).toBe(200);
    expect((await pending(tokens.math(), I.engTeacher)).status).toBe(403);
    expect((await pending(tokens.principalA(), I.engTeacher)).status).toBe(200);
    for (const auth of [tokens.parentA(), tokens.studentS1()]) {
      const res = await pending(auth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe("the teacher's dashboard", () => {
  it('is the teacher\'s, and not the platform admin\'s', async () => {
    expect((await request(app).get(`${base}/dashboard/teacher/overview`).set('Authorization', tokens.math())).status).toBe(200);
    const admin = await request(app).get(`${base}/dashboard/teacher/overview`).set('Authorization', token(ADMIN, 'super_admin', I.schoolB));
    expect(admin.status).toBe(403);
  });
});
