/**
 * A new staff account, and a password reset, tell the truth (audit, 8 Oct 2026).
 *
 * - Settings → Users answered a new staff account with its temporary password, shown on screen to
 *   whoever made it. Moses (8 Oct 2026): "Yes welcome email", as bulk import already did. The
 *   account is made with a password nobody is told; the welcome email says how to set one.
 * - Reset Password answered "sent" whatever happened to the email, sent a link with no return address
 *   (so it opened the home page, where nothing reads it), and for a student whose address is a made-up
 *   `@students.internal` one, mailed a link to nowhere. A student is now given a new temporary
 *   password, shown once, as registration does.
 */
const mockCreateUser = jest.fn();
const mockGetUserById = jest.fn();
const mockGenerateLink = jest.fn();
const mockUpdateUserById = jest.fn();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    createUser: (input: unknown) => mockCreateUser(input),
    getUserById: (id: string) => mockGetUserById(id),
    generateLink: (input: unknown) => mockGenerateLink(input),
    updateUserById: (id: string, attrs: unknown) => mockUpdateUserById(id, attrs),
  } } },
}));
const mockSendEmail = jest.fn();
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  isEmailConfigured: () => true,
}));

import crypto from 'crypto';
import request from 'supertest';
import { pool, seed, IDS as I, buildApp, tokens } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;

beforeEach(async () => {
  await seed();
  for (const m of [mockCreateUser, mockGetUserById, mockGenerateLink, mockUpdateUserById, mockSendEmail]) m.mockReset();
  mockCreateUser.mockImplementation(async (input: { email: string }) => ({ data: { user: { id: crypto.randomUUID(), email: input.email } }, error: null }));
  mockGetUserById.mockImplementation(async (id: string) => {
    const { rows } = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id]);
    return { data: { user: rows[0] ? { id, email: rows[0].email } : null }, error: null };
  });
  mockGenerateLink.mockResolvedValue({ data: { properties: { action_link: 'https://auth.example.test/verify?type=recovery&token=t' } }, error: null });
  mockUpdateUserById.mockResolvedValue({ data: { user: {} }, error: null });
  mockSendEmail.mockResolvedValue('sent');
});
afterAll(() => pool.end());

describe('a new staff account', () => {
  it('is emailed a welcome, and no password is returned', async () => {
    const res = await request(app).post(`${base}/users`).set('Authorization', tokens.principalA())
      .send({ email: 'new.teacher@example.test', first_name: 'New', last_name: 'Teacher', role: 'teacher', teacher_mode: 'subject' });
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('temp_password');
    expect(JSON.stringify(res.body)).not.toMatch(/password"\s*:/i);
    expect(res.body.data.welcome_email).toBe('sent');
    // The email says how to set a password, and carries none.
    const [to, , body] = mockSendEmail.mock.calls[0];
    expect(to).toBe('new.teacher@example.test');
    expect(body).toContain('/forgot-password');
    expect(body).not.toMatch(/temporary password|your password is/i);
  });

  it('says so when the welcome email did not go', async () => {
    mockSendEmail.mockResolvedValue('queued');
    const res = await request(app).post(`${base}/users`).set('Authorization', tokens.principalA())
      .send({ email: 'other.teacher@example.test', first_name: 'Other', last_name: 'Teacher', role: 'bursar' });
    expect(res.status).toBe(201);
    expect(res.body.data.welcome_email).toBe('not_sent');
  });
});

describe('Reset Password', () => {
  const reset = (userId: string) => request(app).post(`${base}/users/${userId}/reset-password`).set('Authorization', tokens.principalA());

  it('sends a link that returns to the reset page, and says sent only when it went', async () => {
    const ok = await reset(I.mathTeacher);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ sent: true });
    expect(mockGenerateLink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recovery', options: expect.objectContaining({ redirectTo: expect.stringMatching(/\/reset-password$/) }),
    }));

    mockSendEmail.mockResolvedValue('queued');
    const notSent = await reset(I.mathTeacher);
    expect(notSent.status).toBe(200);
    expect(notSent.body.data.sent).toBe(false);
    expect(notSent.body.data.message).toMatch(/not sent/i);
  });

  it('gives a student with no real email a new temporary password, once, and mails nothing', async () => {
    await pool.query(`UPDATE users SET email = 'sch-2026-0001@students.internal' WHERE id = $1`, [I.s1User]);
    const res = await reset(I.s1User);
    expect(res.status).toBe(200);
    expect(res.body.data.temp_password).toMatch(/^\S{10,}$/);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
    expect(mockUpdateUserById).toHaveBeenCalledWith(I.s1User, { password: res.body.data.temp_password });
    const { rows: [u] } = await pool.query(`SELECT must_change_password FROM users WHERE id = $1`, [I.s1User]);
    expect(u.must_change_password).toBe(true);
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action_type = 'USER_TEMP_PASSWORD_SET' AND entity_id = $1`, [I.s1User]);
    expect(audit.rowCount).toBe(1);
  });
});
