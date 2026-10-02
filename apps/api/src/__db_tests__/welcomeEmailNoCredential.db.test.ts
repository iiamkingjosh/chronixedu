/**
 * Item H2 (1 Oct 2026, option (iii), decided by Moses): staff and parent welcome emails carry no
 * credential. They say the account is ready and how to set a password with "Forgot password", which
 * mails a link to the same address. Because whoever reads that mailbox can then take the account, the
 * address has to be right before anything is created:
 *   - a single parent's address is typed twice (register-with-parent, add-parent);
 *   - a bulk import names the addresses it will create and mail in its preview, and the commit is
 *     refused until the operator confirms them.
 * And the response says plainly whether the email went.
 *
 * Every refusal here is preceded by the same request succeeding (doctrine 16): "400 and no account"
 * is also what a broken route produces.
 *
 * Supabase Auth and the email sender are mocked at their boundary only. The Auth mock records the
 * password each new account was given, so a test can check no email contains it.
 */
import request from 'supertest';
import ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';
import { logger } from '../config/logger';

const issuedPasswords = new Map<string, string>();
// The Auth identities that exist (id -> address), as the welcome path's sign-in check sees them.
const identities = new Map<string, string>();
// Addresses whose account is created WITHOUT an identity: a path that skips createAuthAccountFor.
const loseIdentityFor = new Set<string>();
jest.mock('../supabaseClient', () => ({
  supabase: {},
  supabaseAdmin: { auth: { admin: {
    createUser: jest.fn(async ({ email, password }: { email: string; password: string }) => {
      issuedPasswords.set(email, password);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const id: string = require('crypto').randomUUID();
      if (!loseIdentityFor.has(email)) identities.set(id, email);
      return { data: { user: { id } }, error: null };
    }),
    getUserById: jest.fn(async (id: string) => (identities.has(id)
      ? { data: { user: { id, email: identities.get(id) } }, error: null }
      : { data: { user: null }, error: { message: 'User not found', status: 404 } })),
  } } },
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => true),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const emailService = require('../services/emailService');
/* eslint-enable @typescript-eslint/no-var-requires */

const app = buildApp();
const A = I.schoolA;

type Sent = { to: string; subject: string; body: string };
const sent = (): Sent[] => (emailService.sendEmail as jest.Mock).mock.calls.map(([to, subject, body]) => ({ to, subject, body }));

/** No email may contain a password any account was given, or anything that looks like one. */
function expectNoCredentialIn(mails: Sent[]) {
  expect(mails.length).toBeGreaterThan(0);
  expect(issuedPasswords.size).toBeGreaterThan(0);
  for (const m of mails) {
    for (const pw of issuedPasswords.values()) expect(m.body).not.toContain(pw);
    expect(m.body).not.toMatch(/password:[ \t]*\S/i);
    expect(m.body).not.toMatch(/token=|access_token|type=recovery/i);
    expect(m.body).toContain('/forgot-password');
    expect(m.body).toContain(`Enter ${m.to}`);
  }
}

/** A parent who already has an account at School A. The seeded parent's address (`<id>@test`) is not
 *  one a form would accept, so it cannot stand in. */
async function existingParent(): Promise<string> {
  const email = `existing-parent-${randomUUID()}@example.test`;
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name)
     VALUES (gen_random_uuid(), $1, $2, 'x', 'parent', 'Existing', 'Parent')`, [A, email]);
  return email;
}

const userCount = async (email: string) =>
  Number((await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = LOWER($1)`, [email])).rows[0].n);

beforeEach(async () => {
  await seed();
  issuedPasswords.clear();
  identities.clear();
  loseIdentityFor.clear();
  (emailService.sendEmail as jest.Mock).mockReset().mockImplementation(async () => 'sent');
  (emailService.isEmailConfigured as jest.Mock).mockImplementation(() => true);
});
afterAll(async () => { await pool.end(); });

const parent = (email: string, confirmation: string) => ({
  email, email_confirmation: confirmation, first_name: 'Ngozi', last_name: 'Eze', relationship_type: 'Mother', is_primary_contact: true,
});

describe('registering a student with a parent: the address is typed twice', () => {
  it('creates the parent and mails them a welcome with no credential when both entries match', async () => {
    const email = `ngozi-${randomUUID()}@example.test`;
    const res = await request(app).post(`/api/schools/${A}/students`).set('Authorization', tokens.principalA())
      .send({ first_name: 'Chidi', last_name: 'Eze', parents: [parent(email, ` ${email.toUpperCase()} `)] });
    expect(res.status).toBe(201);
    expect(res.body.data.welcome_email).toBe('sent');
    expect(await userCount(email)).toBe(1);

    const mails = sent();
    expect(mails.map(m => m.to)).toEqual([email]);
    expectNoCredentialIn(mails);
    // The screen still shows the temporary password (scope: the registrar's screens are unchanged);
    // the email does not carry it.
    expect(mails[0].body).not.toContain(res.body.data.new_parents[0].temp_password);
  });

  it('refuses when the two entries differ, and creates nothing', async () => {
    const email = `ngozi-${randomUUID()}@example.test`;
    const res = await request(app).post(`/api/schools/${A}/students`).set('Authorization', tokens.principalA())
      .send({ first_name: 'Chidi', last_name: 'Eze', parents: [parent(email, email.replace('ngozi', 'ngozl'))] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toContain('do not match');
    expect(await userCount(email)).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('refuses when the second entry is missing', async () => {
    const email = `ngozi-${randomUUID()}@example.test`;
    const withoutConfirmation = { email, first_name: 'Ngozi', last_name: 'Eze', relationship_type: 'Mother', is_primary_contact: true };
    const res = await request(app).post(`/api/schools/${A}/students`).set('Authorization', tokens.principalA())
      .send({ first_name: 'Chidi', last_name: 'Eze', parents: [withoutConfirmation] });
    expect(res.status).toBe(400);
    expect(await userCount(email)).toBe(0);
  });
});

describe('adding a parent to a student: the address is typed twice', () => {
  const add = (body: object) =>
    request(app).post(`/api/schools/${A}/students/${I.s2}/parents`).set('Authorization', tokens.principalA()).send(body);

  it('creates the parent and mails a welcome with no credential when both entries match', async () => {
    const email = `guardian-${randomUUID()}@example.test`;
    const res = await add(parent(email, email));
    expect(res.status).toBe(201);
    expect(res.body.data.is_new_account).toBe(true);
    expect(res.body.data.welcome_email).toBe('sent');
    const mails = sent();
    expect(mails.map(m => m.to)).toEqual([email]);
    expectNoCredentialIn(mails);
    expect(mails[0].body).not.toContain(res.body.data.temp_password);
  });

  it('refuses to tell an account with no Auth login to use Forgot password, and raises the alert', async () => {
    // A path that creates the users row but not the Supabase Auth identity. Forgot password answers
    // the same 200 for every address (Round 24), so that person would get a success message and no
    // email, every time, and nothing would log it. The welcome path refuses rather than sends.
    const email = `guardian-${randomUUID()}@example.test`;
    loseIdentityFor.add(email);
    const error = jest.spyOn(logger, 'error');
    const res = await add(parent(email, email));
    expect(res.status).toBe(201);
    expect(await userCount(email)).toBe(1);
    expect(res.body.data.welcome_email).toBe('not_sent');
    expect(sent()).toEqual([]);
    const calls = error.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(calls.filter(([event]) => event === 'welcome_email_no_login'))
      .toEqual([['welcome_email_no_login', expect.objectContaining({ not_sent: 1, of: 1 })]]);
    error.mockRestore();
  });

  it('refuses when the two entries differ, and creates nothing', async () => {
    const email = `guardian-${randomUUID()}@example.test`;
    const res = await add(parent(email, `x${email}`));
    expect(res.status).toBe(400);
    expect(await userCount(email)).toBe(0);
    expect(sent()).toEqual([]);
  });

  it("linking an existing parent mails nobody, and says so ('none')", async () => {
    const existing = await existingParent();
    const res = await add(parent(existing, existing));
    expect(res.status).toBe(201);
    expect(res.body.data.is_new_account).toBe(false);
    expect(res.body.data.welcome_email).toBe('none');
    expect(sent()).toEqual([]);
  });

  it("says 'not_sent' when email is not configured on the server, and logs it", async () => {
    (emailService.isEmailConfigured as jest.Mock).mockImplementation(() => false);
    const warn = jest.spyOn(logger, 'warn');
    const email = `guardian-${randomUUID()}@example.test`;
    const res = await add(parent(email, email));
    expect(res.status).toBe(201);
    expect(res.body.data.welcome_email).toBe('not_sent');
    expect(sent()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('welcome_email_skipped_unconfigured', expect.objectContaining({ school_id: A, count: 1 }));
    warn.mockRestore();
  });
});

async function xlsx(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('student bulk import: the parent addresses are shown, then confirmed', () => {
  const HEADERS = ['First Name', 'Last Name', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'];

  async function preview(rows: string[][]) {
    const res = await request(app).post(`/api/schools/${A}/students/bulk-import/preview`).set('Authorization', tokens.principalA())
      .attach('file', await xlsx(HEADERS, rows), 'students.xlsx');
    expect(res.status).toBe(200);
    return res.body.data as { rows: Array<{ status: string }>; mailed_addresses: string[] };
  }
  const commit = (body: object) =>
    request(app).post(`/api/schools/${A}/students/bulk-import/commit`).set('Authorization', tokens.principalA()).send(body);

  it('the preview lists exactly the addresses the commit then creates and mails, and the audit row records them', async () => {
    const existing = await existingParent();
    const newA = `bulk-a-${randomUUID()}@example.test`;
    const newB = `bulk-b-${randomUUID()}@example.test`;
    const data = await preview([
      ['Ada', 'One', 'Pa', 'One', newA, 'Father'],
      ['Ade', 'One', 'Pa', 'One', newA, 'Father'],       // a sibling: one account, one email
      ['Bola', 'Two', 'Ma', 'Two', newB, 'Mother'],
      ['Chi', 'Three', 'Old', 'Parent', existing, 'Mother'], // already has an account: linked, not mailed
      ['', 'NoFirstName', 'Ma', 'Four', `bulk-invalid-${randomUUID()}@example.test`, 'Mother'], // invalid row: not created
    ]);
    expect(data.mailed_addresses.sort()).toEqual([newA, newB].sort());

    const res = await commit({ rows: data.rows.filter(r => r.status === 'valid'), mailed_addresses_confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(4);
    expect(res.body.data.welcome_emails).toBe('sent');

    const mails = sent();
    expect(mails.map(m => m.to).sort()).toEqual([newA, newB].sort());
    expectNoCredentialIn(mails);

    const audit = (await pool.query(
      `SELECT new_value FROM audit_logs WHERE school_id = $1 AND action_type = 'STUDENTS_BULK_IMPORT' ORDER BY created_at DESC LIMIT 1`, [A])).rows[0].new_value;
    expect(audit.mailed_addresses_confirmed).toBe(true);
    expect(audit.welcome_emails).toBe('sent');
    expect([...audit.mailed_addresses].sort()).toEqual([newA, newB].sort());
  });

  it('refuses a commit that does not confirm the addresses, before creating anything', async () => {
    const email = `bulk-${randomUUID()}@example.test`;
    const data = await preview([['Ada', 'One', 'Pa', 'One', email, 'Father']]);
    expect(data.mailed_addresses).toEqual([email]);
    const valid = data.rows.filter(r => r.status === 'valid');

    for (const confirmation of [undefined, false, 'true']) {
      const res = await commit({ rows: valid, ...(confirmation === undefined ? {} : { mailed_addresses_confirmed: confirmation }) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(confirmation === 'true' ? 'VALIDATION_ERROR' : 'MAILED_ADDRESSES_NOT_CONFIRMED');
    }
    expect(await userCount(email)).toBe(0);
    expect(issuedPasswords.size).toBe(0);
    expect(sent()).toEqual([]);

    // The same rows, confirmed, go through: the refusal was the confirmation, not the rows.
    const ok = await commit({ rows: valid, mailed_addresses_confirmed: true });
    expect(ok.status).toBe(200);
    expect(await userCount(email)).toBe(1);
  });
});

describe('staff bulk import: the addresses are shown, then confirmed', () => {
  const HEADERS = ['Email', 'First Name', 'Last Name', 'Role', 'Title', 'Phone', 'Teaching Mode'];

  async function preview(rows: string[][]) {
    const res = await request(app).post(`/api/schools/${A}/staff-bulk-import/preview`).set('Authorization', tokens.principalA())
      .attach('file', await xlsx(HEADERS, rows), 'staff.xlsx');
    expect(res.status).toBe(200);
    return res.body.data as { rows: Array<{ status: string }>; mailed_addresses: string[] };
  }
  const commit = (body: object) =>
    request(app).post(`/api/schools/${A}/staff-bulk-import/commit`).set('Authorization', tokens.principalA()).send(body);

  it('the preview lists the addresses, and the confirmed commit mails each a welcome with no credential', async () => {
    const reg = `registrar-${randomUUID()}@example.test`;
    const bur = `bursar-${randomUUID()}@example.test`;
    const data = await preview([
      [reg, 'Rita', 'Reg', 'registrar', '', '', ''],
      [bur, 'Bayo', 'Bur', 'bursar', '', '', ''],
      ['not-an-email', 'Bad', 'Row', 'bursar', '', '', ''],
    ]);
    expect(data.mailed_addresses).toEqual([reg, bur]);

    const res = await commit({ rows: data.rows.filter(r => r.status === 'valid'), mailed_addresses_confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.welcome_emails).toBe('sent');

    const mails = sent();
    expect(mails.map(m => m.to)).toEqual([reg, bur]);
    expectNoCredentialIn(mails);
    // The staff temporary password is now known to nobody: they set their own with Forgot password.
    expect([...issuedPasswords.keys()].sort()).toEqual([reg, bur].sort());

    const audit = (await pool.query(
      `SELECT new_value FROM audit_logs WHERE school_id = $1 AND action_type = 'STAFF_BULK_IMPORT' ORDER BY created_at DESC LIMIT 1`, [A])).rows[0].new_value;
    expect(audit.mailed_addresses_confirmed).toBe(true);
    expect(audit.mailed_addresses).toEqual([reg, bur]);
  });

  it("says 'partly_sent' and names the address SendGrid refused, which a resolved send used to hide", async () => {
    const reg = `registrar-${randomUUID()}@example.test`;
    const bur = `bursar-${randomUUID()}@example.test`;
    // sendEmail never throws: a refused send is queued for retry and returns normally. It used to
    // return nothing, and the welcome path counted that as sent.
    (emailService.sendEmail as jest.Mock).mockImplementation(async (to: string) => (to === bur ? 'queued' : 'sent'));
    const error = jest.spyOn(logger, 'error');
    const data = await preview([[reg, 'Rita', 'Reg', 'registrar', '', '', ''], [bur, 'Bayo', 'Bur', 'bursar', '', '', '']]);

    const res = await commit({ rows: data.rows, mailed_addresses_confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.welcome_emails).toBe('partly_sent');
    expect(res.body.data.welcome_emails_not_sent).toEqual([bur]);
    // The welcome_email_not_sent alert fires, with counts and no address.
    // winston's overloads type the spy's calls as one object; the route calls logger.error(event, meta).
    const calls = error.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    const failed = calls.filter(([event]) => event === 'welcome_email_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ stage: 'send', not_sent: 1, of: 2 });
    expect(JSON.stringify(failed[0][1])).not.toContain('@');
    error.mockRestore();

    const audit = (await pool.query(
      `SELECT new_value FROM audit_logs WHERE school_id = $1 AND action_type = 'STAFF_BULK_IMPORT' ORDER BY created_at DESC LIMIT 1`, [A])).rows[0].new_value;
    expect(audit.welcome_emails).toBe('partly_sent');
    expect(audit.welcome_emails_not_sent).toEqual([bur]);
  });

  it('refuses a commit that does not confirm the addresses, before creating anything', async () => {
    const email = `registrar-${randomUUID()}@example.test`;
    const data = await preview([[email, 'Rita', 'Reg', 'registrar', '', '', '']]);
    const valid = data.rows.filter(r => r.status === 'valid');

    const refused = await commit({ rows: valid });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('MAILED_ADDRESSES_NOT_CONFIRMED');
    expect(await userCount(email)).toBe(0);
    expect(issuedPasswords.size).toBe(0);
    expect(sent()).toEqual([]);

    const ok = await commit({ rows: valid, mailed_addresses_confirmed: true });
    expect(ok.status).toBe(200);
    expect(await userCount(email)).toBe(1);
  });
});
