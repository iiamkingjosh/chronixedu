/**
 * A new platform admin's email carries no credential (2 Oct 2026, SECURITY.md Round 30). The route
 * took a password the root admin typed and emailed it in plain text: for the account type that can
 * reach every school. "Resend welcome" minted a recovery link with no redirect, which landed on the
 * home page where nothing reads it.
 *
 * Now: no password is taken or set; the address is typed twice; the welcome and its resend say the
 * account exists and how to use Forgot password; the response says whether the email went. Every
 * refusal below is preceded by the same request succeeding (doctrine 16).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { seed, pool } from './helpers';
import superAdminRoutes from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';

const createdWith: Array<Record<string, unknown>> = [];
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    createUser: jest.fn(async (args: Record<string, unknown>) => {
      createdWith.push(args);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return { data: { user: { id: require('crypto').randomUUID() } }, error: null };
    }),
    generateLink: jest.fn(async () => ({ data: { properties: { action_link: 'https://auth.example.test/verify?token=t' } }, error: null })),
  } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => true),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const { supabaseAdmin } = require('../supabaseClient');
const emailService = require('../services/emailService');
/* eslint-enable @typescript-eslint/no-var-requires */

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRoutes);
app.use(errorHandler);

const ROOT = 'c0000000-0000-4000-8000-0000000000aa';
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL!;
const auth = () => 'Bearer ' + jwt.sign({ user_id: ROOT, school_id: null, role: 'super_admin', email: ROOT_EMAIL }, process.env.JWT_SECRET!);

beforeEach(async () => {
  await seed();
  createdWith.length = 0;
  jest.clearAllMocks();
  (emailService.sendEmail as jest.Mock).mockImplementation(async () => 'sent');
  (emailService.isEmailConfigured as jest.Mock).mockImplementation(() => true);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
     VALUES ($1, NULL, $2, 'x', 'super_admin', 'Root', 'Admin')`, [ROOT, ROOT_EMAIL]);
});
afterAll(async () => { await pool.end(); });

const create = (body: object) => request(app).post('/api/super-admin/admins').set('Authorization', auth()).send(body);
const admin = (email: string, confirmation = email) => ({ first_name: 'Ada', last_name: 'Obi', email, email_confirmation: confirmation });

/** The welcome must never carry a credential, only the way to set one. */
function expectNoCredential(body: string, email: string) {
  expect(body).toContain(`Your login email is ${email}.`);
  expect(body).toContain('http://localhost:3000/forgot-password');
  expect(body).toContain(`Enter ${email}`);
  expect(body).not.toMatch(/password:[ \t]*\S/i);
  expect(body).not.toMatch(/token=|access_token|type=recovery|verify\?/i);
}

describe('adding a platform admin', () => {
  it('creates the account with no password, and emails how to set one, nothing more', async () => {
    const email = `admin-${randomUUID()}@example.test`;
    const res = await create(admin(email));
    expect(res.status).toBe(201);
    expect(res.body.data.welcome_email).toBe('sent');

    expect(createdWith).toHaveLength(1);
    expect(createdWith[0]).toMatchObject({ email, email_confirm: true });
    expect(createdWith[0]).not.toHaveProperty('password');
    const row = (await pool.query(`SELECT role, school_id, password_hash FROM users WHERE email = $1`, [email])).rows[0];
    expect(row).toEqual({ role: 'super_admin', school_id: null, password_hash: '' });

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, , body] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(to).toBe(email);
    expectNoCredential(body, email);
    expect(supabaseAdmin.auth.admin.generateLink).not.toHaveBeenCalled();
  });

  it('refuses a password rather than ignoring it, and creates nothing', async () => {
    const email = `admin-${randomUUID()}@example.test`;
    const res = await create({ ...admin(email), password: 'Chosen-by-root-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_NOT_ACCEPTED');
    expect(createdWith).toHaveLength(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses when the two addresses differ, and creates nothing', async () => {
    const email = `admin-${randomUUID()}@example.test`;
    const res = await create(admin(email, `x${email}`));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toContain('do not match');
    expect(createdWith).toHaveLength(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("says 'not_sent' when SendGrid refuses the email, rather than counting a queued email as sent", async () => {
    (emailService.sendEmail as jest.Mock).mockImplementation(async () => 'queued');
    const email = `admin-${randomUUID()}@example.test`;
    const res = await create(admin(email));
    expect(res.status).toBe(201);
    expect(res.body.data.welcome_email).toBe('not_sent');
  });
});

describe('resending the welcome', () => {
  it('sends the same email, with no link and no credential', async () => {
    const email = `admin-${randomUUID()}@example.test`;
    const created = await create(admin(email));
    expect(created.status).toBe(201);
    (emailService.sendEmail as jest.Mock).mockClear();

    const res = await request(app).post(`/api/super-admin/admins/${created.body.data.user_id}/resend-welcome`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ email, welcome_email: 'sent' });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, , body] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(to).toBe(email);
    expectNoCredential(body, email);
    expect(supabaseAdmin.auth.admin.generateLink).not.toHaveBeenCalled();
  });
});
