import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';

// jest.mock is hoisted above this import, but the factory body only runs
// lazily (when createUser is actually invoked during a test), by which
// point the module has finished loading and randomUUID is bound — safe to
// close over it here instead of using an inline require().
jest.mock('../src/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: jest.fn() } },
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: jest.fn().mockImplementation(({ email }: { email: string }) =>
          Promise.resolve({ data: { user: { id: randomUUID(), email } }, error: null })
        ),
      },
    },
  },
}));
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import dashboardRouter from '../src/routes/dashboard';
import usersRouter from '../src/routes/users';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', dashboardRouter);
app.use('/api/schools', usersRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

// Regression coverage for a real bug found in this pass: the principal
// dashboard's overview stats (staff/student counts) were cached for 5
// minutes with nothing invalidating that cache on user creation, so a
// newly created staff account wouldn't show up on the dashboard until the
// cache naturally expired.
describe('Principal dashboard stats cache invalidation', () => {
  const suffix = randomUUID().slice(0, 8);
  let schoolId: string;
  let principalToken: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ('Dashboard Cache Test', $1, true) RETURNING id`,
      [`dashboard-cache-${suffix}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', FALSE) RETURNING id, email`,
      [schoolId, `principal-${suffix}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    await Promise.race([
      pool.end(),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }, 15000);

  it('reflects a newly created teacher immediately, not after the cache TTL', async () => {
    const before = await request(app)
      .get(`/api/schools/${schoolId}/dashboard/principal/overview`)
      .set('Authorization', `Bearer ${principalToken}`);
    expect(before.status).toBe(200);
    expect(before.body.data.total_teachers).toBe(0);

    // This warms the dashboard-stats cache — the bug this test guards
    // against is that the cache, once warm, never gets busted on write.
    const createRes = await request(app)
      .post(`/api/schools/${schoolId}/users`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({
        email: `new-teacher-${suffix}@test.com`,
        first_name: 'New',
        last_name: 'Teacher',
        role: 'teacher',
        teacher_mode: 'subject',
      });
    expect(createRes.status).toBe(201);

    const after = await request(app)
      .get(`/api/schools/${schoolId}/dashboard/principal/overview`)
      .set('Authorization', `Bearer ${principalToken}`);
    expect(after.status).toBe(200);
    expect(after.body.data.total_teachers).toBe(1);
  }, 30000);
});
