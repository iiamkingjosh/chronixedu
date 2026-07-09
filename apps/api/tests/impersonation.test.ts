import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import { detectSupportSession, SupportSessionClaims } from '../src/middleware/detectSupportSession';
import { errorHandler } from '../src/middleware/errorHandler';

// Minimal app: detectSupportSession + a route that echoes req.user
const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession);
app.get('/api/schools/:schoolId/whoami', (req: Request, res: Response) => {
  res.json({ user: req.user ?? null });
});
app.use(errorHandler);

function makeSupportJWT(claims: SupportSessionClaims): string {
  return jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('Support Session Impersonation', () => {
  let platformAdminId: string;
  let targetSchoolId: string;
  let targetUserId: string;
  let supportSessionId: string;
  let supportToken: string;

  beforeAll(async () => {
    const saResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES (NULL, $1, 'test-hash', 'super_admin', 'Impersonation', 'Admin', 'subject')
       RETURNING id`,
      [`impersonation-admin-${randomUUID()}@test.com`]
    );
    platformAdminId = saResult.rows[0].id;

    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Impersonation Test School', `test-impersonation-${randomUUID()}`]
    );
    targetSchoolId = schoolResult.rows[0].id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Target', 'Principal', 'subject')
       RETURNING id`,
      [targetSchoolId, `impersonation-principal-${randomUUID()}@test.com`]
    );
    targetUserId = userResult.rows[0].id;

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO support_sessions (platform_admin_id, school_id, impersonated_user_id, reason, actions_taken)
       VALUES ($1, $2, $3, $4, '[]'::jsonb)
       RETURNING id`,
      [platformAdminId, targetSchoolId, targetUserId, 'Impersonation integration test']
    );
    supportSessionId = sessionResult.rows[0].id;

    const claims: SupportSessionClaims = {
      support_session_id: supportSessionId,
      is_support_session: true,
      real_admin_id: platformAdminId,
      impersonated_user_id: targetUserId,
      impersonated_school_id: targetSchoolId,
      impersonated_role: 'principal',
      impersonated_email: 'target@test.com',
      impersonated_title: null,
    };
    supportToken = makeSupportJWT(claims);
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM support_sessions WHERE id = $1`, [supportSessionId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [targetUserId]).catch(() => {});
    await pool.query(`DELETE FROM schools WHERE id = $1`, [targetSchoolId]).catch(() => {});
    await pool.query(`DELETE FROM platform_audit_logs WHERE platform_admin_id = $1`, [platformAdminId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [platformAdminId]).catch(() => {});
    await pool.end();
  }, 20000);

  it('no X-Support-Session-ID header → passes through (next called, no user set)', async () => {
    const res = await request(app).get(`/api/schools/${targetSchoolId}/whoami`);
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('valid support session → req.user set to impersonated principal', async () => {
    const res = await request(app)
      .get(`/api/schools/${targetSchoolId}/whoami`)
      .set('Authorization', `Bearer ${supportToken}`)
      .set('X-Support-Session-ID', supportSessionId);
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.user_id).toBe(targetUserId);
    expect(res.body.user.role).toBe('principal');
    expect(res.body.user.school_id).toBe(targetSchoolId);
  });

  it('X-Support-Session-ID present but no Authorization header → 401', async () => {
    const res = await request(app)
      .get(`/api/schools/${targetSchoolId}/whoami`)
      .set('X-Support-Session-ID', supportSessionId);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('session ID in header does not match token claim → 401 SESSION_MISMATCH', async () => {
    const res = await request(app)
      .get(`/api/schools/${targetSchoolId}/whoami`)
      .set('Authorization', `Bearer ${supportToken}`)
      .set('X-Support-Session-ID', randomUUID()); // wrong session ID
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_MISMATCH');
  });

  it('invalid JWT in Authorization header → 401 INVALID_SUPPORT_TOKEN', async () => {
    const res = await request(app)
      .get(`/api/schools/${targetSchoolId}/whoami`)
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .set('X-Support-Session-ID', supportSessionId);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SUPPORT_TOKEN');
  });

  it('support session with ended_at set → 401 SESSION_ENDED', async () => {
    // Create a separate ended session
    const endedResult = await pool.query<{ id: string }>(
      `INSERT INTO support_sessions (platform_admin_id, school_id, impersonated_user_id, reason, actions_taken, ended_at)
       VALUES ($1, $2, $3, 'Ended session test', '[]'::jsonb, NOW())
       RETURNING id`,
      [platformAdminId, targetSchoolId, targetUserId]
    );
    const endedSessionId = endedResult.rows[0].id;

    const claims: SupportSessionClaims = {
      support_session_id: endedSessionId,
      is_support_session: true,
      real_admin_id: platformAdminId,
      impersonated_user_id: targetUserId,
      impersonated_school_id: targetSchoolId,
      impersonated_role: 'principal',
      impersonated_email: 'target@test.com',
      impersonated_title: null,
    };
    const endedToken = makeSupportJWT(claims);

    const res = await request(app)
      .get(`/api/schools/${targetSchoolId}/whoami`)
      .set('Authorization', `Bearer ${endedToken}`)
      .set('X-Support-Session-ID', endedSessionId);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_ENDED');

    await pool.query(`DELETE FROM support_sessions WHERE id = $1`, [endedSessionId]).catch(() => {});
  }, 20000);

  it('non-existent session ID in DB → 401 SESSION_ENDED', async () => {
    const fakeSessionId = randomUUID();
    const claims: SupportSessionClaims = {
      support_session_id: fakeSessionId,
      is_support_session: true,
      real_admin_id: platformAdminId,
      impersonated_user_id: targetUserId,
      impersonated_school_id: targetSchoolId,
      impersonated_role: 'principal',
      impersonated_email: 'target@test.com',
      impersonated_title: null,
    };
    const fakeToken = makeSupportJWT(claims);

    const res = await request(app)
      .get(`/api/schools/${targetSchoolId}/whoami`)
      .set('Authorization', `Bearer ${fakeToken}`)
      .set('X-Support-Session-ID', fakeSessionId);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_ENDED');
  });
});
