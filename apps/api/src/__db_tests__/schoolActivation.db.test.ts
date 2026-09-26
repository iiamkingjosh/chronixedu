/**
 * A school must never go live without someone who can administer it.
 *
 * Two paths created an active, unadministerable tenant:
 *
 *   POST /onboarding/:sessionId/complete — activated the school, THEN looked up a
 *     principal, and only to find an address for the welcome email. Step 6 is
 *     completable without creating a principal, so the wizard could finish and hand
 *     over a school with no way in, silently.
 *
 *   POST /api/schools — inserts a school and nothing else. schools.is_active defaults
 *     to TRUE, so any super_admin could create a live tenant with no users at all in a
 *     single request. This is the likelier origin of the 44 fixture schools.
 *
 * The onboarding wizard's own creation step already had this right: is_active FALSE at
 * creation, flipped on completion. These tests pin both paths to that model.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { seed, IDS as I, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import schoolsRoutes from '../routes/schools';
import { verifyToken } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/schools', verifyToken, schoolsRoutes);
app.use(errorHandler);

const SUPER = 'c0000000-0000-4000-8000-000000000001';
const superToken = () =>
  'Bearer ' + jwt.sign(
    { user_id: SUPER, school_id: null, role: 'super_admin', email: 'root@test' },
    process.env.JWT_SECRET!
  );

beforeEach(async () => {
  await seed();
  // platform_audit_logs.platform_admin_id is a FK to users, and the completion route
  // writes one, so the acting super_admin needs a real row.
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
     VALUES ($1, NULL, 'root@test', 'x', 'super_admin', 'Root', 'Admin')
     ON CONFLICT (id) DO NOTHING`,
    [SUPER]
  );
});
afterAll(() => pool.end());

/** A school mid-onboarding with all six steps ticked, and no principal. */
async function onboardingSession(): Promise<{ sessionId: string; schoolId: string }> {
  const school = await pool.query<{ id: string }>(
    `INSERT INTO schools (name, slug, email, is_active, subscription_tier)
     VALUES ('Wizard School', $1, $2, FALSE, 'trial') RETURNING id`,
    [`wizard-${Date.now()}`, `wizard-${Date.now()}@example.com`]
  );
  const schoolId = school.rows[0].id;
  const steps = JSON.stringify({ '1': {}, '2': {}, '3': {}, '4': {}, '5': {}, '6': {} });
  const session = await pool.query<{ id: string }>(
    `INSERT INTO onboarding_sessions (school_id, created_by, status, steps_completed)
     VALUES ($1, $2, 'in_progress', $3::jsonb) RETURNING id`,
    [schoolId, I.principalA, steps]
  );
  return { sessionId: session.rows[0].id, schoolId };
}

async function isActive(schoolId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_active: boolean }>(
    `SELECT is_active FROM schools WHERE id = $1`, [schoolId]);
  return rows[0].is_active;
}

describe('onboarding completion requires a principal', () => {
  it('refuses to complete a school that has no principal', async () => {
    const { sessionId, schoolId } = await onboardingSession();

    const res = await request(app)
      .post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', superToken())
      .send({ accepted_legal_terms: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PRINCIPAL');
    expect(await isActive(schoolId)).toBe(false);
  });

  it('leaves the onboarding session open so it can be finished properly', async () => {
    // The refusal must not burn the session — the operator has to be able to create
    // the principal and complete it.
    const { sessionId } = await onboardingSession();
    await request(app)
      .post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', superToken())
      .send({ accepted_legal_terms: true });

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM onboarding_sessions WHERE id = $1`, [sessionId]);
    expect(rows[0].status).toBe('in_progress');
  });

  it('completes and activates once a principal exists', async () => {
    const { sessionId, schoolId } = await onboardingSession();
    await pool.query(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'x', 'principal', 'Head', 'Teacher')`,
      [schoolId, `head-${Date.now()}@example.com`]
    );

    const res = await request(app)
      .post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', superToken())
      .send({ accepted_legal_terms: true });

    expect(res.status).toBe(200);
    expect(await isActive(schoolId)).toBe(true);
  });

  it('does not accept a principal belonging to a different school', async () => {
    // School A has a principal; the school being onboarded does not.
    const { sessionId, schoolId } = await onboardingSession();
    const res = await request(app)
      .post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', superToken())
      .send({ accepted_legal_terms: true });

    expect(res.status).toBe(400);
    expect(await isActive(schoolId)).toBe(false);
  });
});

describe('reactivation requires a principal too', () => {
  it('refuses to reactivate a suspended school that has no principal', async () => {
    // Otherwise the hole simply moves: create a dormant school with POST /api/schools,
    // reactivate it one request later, same live principalless tenant in two calls.
    const created = await request(app)
      .post('/api/schools').set('Authorization', superToken()).send({ name: 'Dormant School' });
    const schoolId = created.body.data.school.id;

    const res = await request(app)
      .patch(`/api/super-admin/schools/${schoolId}/reactivate`)
      .set('Authorization', superToken())
      .send({ reason: 'Testing reactivation without a principal present' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_PRINCIPAL');
    expect(await isActive(schoolId)).toBe(false);
  });

  it('is enforced on the column itself, so a future writer cannot forget it', async () => {
    // The route check gives a clean 400; this is the backstop under it. The invariant
    // was spread across routes, which is what produced the hole in the first place.
    const created = await request(app)
      .post('/api/schools').set('Authorization', superToken()).send({ name: 'Trigger Backstop School' });
    const schoolId = created.body.data.school.id;

    await expect(
      pool.query(`UPDATE schools SET is_active = true WHERE id = $1`, [schoolId])
    ).rejects.toThrow(/no active principal/);
  });

  it('allows reactivation once a principal exists', async () => {
    const created = await request(app)
      .post('/api/schools').set('Authorization', superToken()).send({ name: 'Reactivatable School' });
    const schoolId = created.body.data.school.id;
    await pool.query(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'x', 'principal', 'Head', 'Teacher')`,
      [schoolId, `head-react-${Date.now()}@example.com`]
    );

    const res = await request(app)
      .patch(`/api/super-admin/schools/${schoolId}/reactivate`)
      .set('Authorization', superToken())
      .send({ reason: 'Principal now exists, reactivating the school' });

    expect(res.status).toBe(200);
    expect(await isActive(schoolId)).toBe(true);
  });

  it('refuses to activate a school whose only principal has been deactivated', async () => {
    // superAdmin.ts deactivates users, so checking role alone let a school reactivate
    // into the same unadministerable state with a disabled principal on file.
    const created = await request(app)
      .post('/api/schools').set('Authorization', superToken()).send({ name: 'Disabled Principal School' });
    const schoolId = created.body.data.school.id;
    await pool.query(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, 'x', 'principal', 'Disabled', 'Principal', FALSE)`,
      [schoolId, `disabled-${Date.now()}@example.com`]
    );

    await expect(
      pool.query(`UPDATE schools SET is_active = true WHERE id = $1`, [schoolId])
    ).rejects.toThrow(/no active principal/);
  });

  it('refuses to INSERT a school that is already active', async () => {
    // This is the path that actually produced 29 active principalless schools in
    // production; the UPDATE guard alone would not have stopped one of them. It cannot
    // be conditional on having a principal — users.school_id references schools, so no
    // principal can exist at insert time. A school is born dormant.
    await expect(
      pool.query(
        `INSERT INTO schools (name, slug, is_active) VALUES ('Born Active', $1, TRUE)`,
        [`born-active-${Date.now()}`]
      )
    ).rejects.toThrow(/cannot be created already active/);
  });

  it('defaults is_active to FALSE, so an INSERT that omits it is dormant', async () => {
    const { rows } = await pool.query<{ is_active: boolean }>(
      `INSERT INTO schools (name, slug) VALUES ('Default Dormant', $1) RETURNING is_active`,
      [`default-dormant-${Date.now()}`]
    );
    expect(rows[0].is_active).toBe(false);
  });

  it('does not block suspending an active school', async () => {
    // The trigger fires only on FALSE -> TRUE. Suspension must stay unaffected.
    const { sessionId, schoolId } = await onboardingSession();
    await pool.query(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'x', 'principal', 'Head', 'Teacher')`,
      [schoolId, `head-susp-${Date.now()}@example.com`]
    );
    await request(app).post(`/api/super-admin/onboarding/${sessionId}/complete`)
      .set('Authorization', superToken()).send({ accepted_legal_terms: true });
    expect(await isActive(schoolId)).toBe(true);

    await expect(
      pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [schoolId])
    ).resolves.toBeDefined();
    expect(await isActive(schoolId)).toBe(false);
  });
});

describe('POST /api/schools creates a dormant school', () => {
  it('does not create a live tenant that nobody can administer', async () => {
    const res = await request(app)
      .post('/api/schools')
      .set('Authorization', superToken())
      .send({ name: 'Direct Create School' });

    expect(res.status).toBe(201);
    expect(res.body.data.school.is_active).toBe(false);

    const { rows } = await pool.query<{ is_active: boolean; n: string }>(
      `SELECT s.is_active, (SELECT count(*) FROM users u WHERE u.school_id = s.id) AS n
         FROM schools s WHERE s.id = $1`,
      [res.body.data.school.id]
    );
    expect(rows[0].is_active).toBe(false);
    expect(Number(rows[0].n)).toBe(0); // no principal — which is exactly why it must be dormant
  });
});
