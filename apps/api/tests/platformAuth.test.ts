import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import superAdminRouter from '../src/routes/superAdmin';
import { errorHandler } from '../src/middleware/errorHandler';

const SCHOOL_ID = 'a8f70089-aef1-4f65-a226-4c68d0380285';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Platform Auth Isolation', () => {
  let superAdminUserId: string;
  let superAdminToken: string;

  beforeAll(async () => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES (NULL, $1, 'test-hash', 'super_admin', 'Platform', 'Auth', 'subject')
       RETURNING id`,
      [`platformauth-admin-${randomUUID()}@test.com`]
    );
    superAdminUserId = result.rows[0].id;
    const row = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [superAdminUserId]);
    superAdminToken = makeToken(superAdminUserId, 'super_admin', null, row.rows[0].email);
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM platform_audit_logs WHERE platform_admin_id = $1`, [superAdminUserId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]);
    await pool.end();
  });

  it('super_admin token → GET /api/super-admin/schools → 200', async () => {
    const res = await request(app)
      .get('/api/super-admin/schools')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('principal token → GET /api/super-admin/schools → 403', async () => {
    const token = makeToken(randomUUID(), 'principal', SCHOOL_ID, 'principal@test.com');
    const res = await request(app)
      .get('/api/super-admin/schools')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('teacher token → GET /api/super-admin/schools → 403', async () => {
    const token = makeToken(randomUUID(), 'teacher', SCHOOL_ID, 'teacher@test.com');
    const res = await request(app)
      .get('/api/super-admin/schools')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('no token → GET /api/super-admin/schools → 401', async () => {
    const res = await request(app).get('/api/super-admin/schools');
    expect(res.status).toBe(401);
  });

  it('expired token → GET /api/super-admin/schools → 401', async () => {
    const token = jwt.sign({ user_id: randomUUID(), role: 'super_admin', school_id: null, email: 'x@test.com' }, process.env.JWT_SECRET!, { expiresIn: '-1s' });
    const res = await request(app)
      .get('/api/super-admin/schools')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
