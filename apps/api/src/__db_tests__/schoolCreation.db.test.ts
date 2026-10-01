/**
 * Whether a school is a customer is a STATED fact, never an unset field (doctrine 8).
 *
 * schools.is_demo defaulted to FALSE, so every school was a customer unless someone remembered
 * otherwise. A typo'd test school ("guyg ", trailing space and all) was counted as a customer in
 * every platform total for a day. Both creation paths — POST /api/schools and the onboarding
 * wizard's POST /api/super-admin/onboarding — now require is_demo, and trim the name.
 *
 * The property, tested on each path, in this order: a school created WITH an explicit choice
 * succeeds and stores exactly that choice; only then, a school created WITHOUT one is refused and
 * nothing is inserted. The success half comes first because a refusal alone also passes on a
 * creation path that is simply broken (doctrine 16).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { seed, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import schoolsRoutes from '../routes/schools';
import { verifyToken } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/schools', verifyToken, schoolsRoutes);
app.use(errorHandler);

const SUPER = 'c0000000-0000-4000-8000-000000000002';
const auth = () => 'Bearer ' + jwt.sign(
  { user_id: SUPER, school_id: null, role: 'super_admin', email: 'creator@test' }, process.env.JWT_SECRET!);

beforeEach(async () => {
  await seed();
  // ONBOARDING_STARTED writes platform_audit_logs, whose platform_admin_id references users.
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
     VALUES ($1, NULL, 'creator@test', 'x', 'super_admin', 'Cre', 'Ator')`, [SUPER]);
});
afterAll(async () => { await pool.end(); });

const schoolCount = async () => (await pool.query(`SELECT count(*)::int n FROM schools`)).rows[0].n as number;
const bySlug = async (slug: string) =>
  (await pool.query(`SELECT name, is_demo FROM schools WHERE slug = $1`, [slug])).rows[0];

describe('POST /api/schools', () => {
  it('stores the stated choice, either way; then refuses a school with no choice and inserts nothing', async () => {
    const customer = await request(app).post('/api/schools').set('Authorization', auth()).send({ name: 'Stated Customer', is_demo: false });
    expect(customer.status).toBe(201);
    expect(await bySlug(customer.body.data.school.slug)).toEqual({ name: 'Stated Customer', is_demo: false });
    const demo = await request(app).post('/api/schools').set('Authorization', auth()).send({ name: 'Stated Demo', is_demo: true });
    expect(demo.status).toBe(201);
    expect(await bySlug(demo.body.data.school.slug)).toEqual({ name: 'Stated Demo', is_demo: true });

    const before = await schoolCount();
    for (const body of [{ name: 'No Choice' }, { name: 'Null Choice', is_demo: null }, { name: 'String Choice', is_demo: 'true' }]) {
      const res = await request(app).post('/api/schools').set('Authorization', auth()).send(body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.message)).toMatch(/is_demo/);
    }
    expect(await schoolCount()).toBe(before);
  });

  it('trims the name, so the stored name and the slug carry no stray spaces', async () => {
    const res = await request(app).post('/api/schools').set('Authorization', auth()).send({ name: '  guyg  ', is_demo: true });
    expect(res.status).toBe(201);
    expect(res.body.data.school.slug).not.toMatch(/^-|-$/);
    expect((await bySlug(res.body.data.school.slug)).name).toBe('guyg');
  });
});

describe('POST /api/super-admin/onboarding (the wizard)', () => {
  const start = (body: Record<string, unknown>) =>
    request(app).post('/api/super-admin/onboarding').set('Authorization', auth()).send(body);

  it('stores the stated choice, either way; then refuses a school with no choice and inserts nothing', async () => {
    const customer = await start({ school_name: 'Wizard Customer', school_email: 'customer@wizard.test', is_demo: false });
    expect(customer.status).toBe(201);
    expect(await bySlug(customer.body.data.school_slug)).toEqual({ name: 'Wizard Customer', is_demo: false });
    const demo = await start({ school_name: 'Wizard Demo', school_email: 'demo@wizard.test', is_demo: true });
    expect(demo.status).toBe(201);
    expect(await bySlug(demo.body.data.school_slug)).toEqual({ name: 'Wizard Demo', is_demo: true });

    const before = await schoolCount();
    const res = await start({ school_name: 'Wizard No Choice', school_email: 'none@wizard.test' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.message)).toMatch(/is_demo/);
    expect(await schoolCount()).toBe(before);
  });

  it('records the choice in the audit trail, and trims the name and email', async () => {
    const res = await start({ school_name: '  Trailing Space School ', school_email: ' trail@wizard.test ', is_demo: true });
    expect(res.status).toBe(201);
    const row = (await pool.query(`SELECT name, email, is_demo FROM schools WHERE id = $1`, [res.body.data.school_id])).rows[0];
    expect(row).toEqual({ name: 'Trailing Space School', email: 'trail@wizard.test', is_demo: true });
    const log = (await pool.query(
      `SELECT metadata FROM platform_audit_logs WHERE action_type = 'ONBOARDING_STARTED' AND target_school_id = $1`, [res.body.data.school_id])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].metadata).toMatchObject({ school_name: 'Trailing Space School', is_demo: true });
  });
});
