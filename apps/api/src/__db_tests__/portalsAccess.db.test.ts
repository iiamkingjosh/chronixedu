/**
 * The parent's, student's and teacher's own screens (Batch 9, task 9; Moses, 8 Oct 2026).
 *
 * - The principal no longer lists every homework assignment in the school: no principal screen used it, and a role
 *   sees what its job uses (the 8 Oct answer to question 5; recorded with its reason in REMOVED).
 * - A parent's screens are the parent's: a platform admin sees a school as one of its users, through a support
 *   session, never as itself (decision 7). They admitted the platform admin, which no screen used.
 */
import express from 'express';
import request from 'supertest';
import { seed, token, tokens, IDS as I, pool } from './helpers';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import assignmentsRoutes from '../routes/assignments';
import parentRoutes from '../routes/parent';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, assignmentsRoutes, parentRoutes);
app.use(errorHandler);
const base = `/api/schools/${I.schoolA}`;
const ADMIN = 'c0000000-0000-4000-8000-000000000091';

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'admin@portals.test', 'x', 'super_admin', 'Plat', 'Form', false, false)`, [ADMIN]);
});
afterAll(() => pool.end());

it('homework is listed for the teacher who set it and the student it is for, not the principal', async () => {
  expect((await request(app).get(`${base}/assignments`).set('Authorization', tokens.math())).status).toBe(200);
  expect((await request(app).get(`${base}/assignments`).set('Authorization', tokens.studentS1())).status).toBe(200);
  const principal = await request(app).get(`${base}/assignments`).set('Authorization', tokens.principalA());
  expect(principal.status).toBe(403);
  expect(principal.body.error.code).toBe('FORBIDDEN');
});

it("a parent's screens are the parent's, not the platform admin's", async () => {
  expect((await request(app).get(`${base}/parent/children`).set('Authorization', tokens.parentA())).status).toBe(200);
  const admin = await request(app).get(`${base}/parent/children`).set('Authorization', token(ADMIN, 'super_admin', I.schoolB));
  expect(admin.status).toBe(403);
});
