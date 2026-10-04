/**
 * Two emails in Chronix's own voice, moved onto the shared layout (2 Oct 2026): the platform
 * announcement a principal receives, and the test email from Settings → Notifications. Both used to
 * say an email went without asking SendGrid:
 * - publishing an announcement answered "sent to N principals", N being who it was addressed to;
 * - the test email answered "Test email sent" whatever SendGrid did.
 * And the announcement's plain text went out with the sanitiser's escaping in it ("Fees &amp; dues").
 *
 * Every "fewer sent" below sits beside the same request with all of them sent (doctrine 16).
 */
import request from 'supertest';
import express from 'express';
import { buildApp, seed, token, tokens, IDS as I, pool } from './helpers';
import superAdminRouter from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';
import { appBaseUrl } from '../config/appUrls';

jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => 'sent'),
  isEmailConfigured: jest.fn(() => true),
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const emailService = require('../services/emailService');
/* eslint-enable @typescript-eslint/no-var-requires */
const sendEmail = emailService.sendEmail as jest.Mock;

const platform = express();
platform.use(express.json());
platform.use('/api/super-admin', superAdminRouter);
platform.use(errorHandler);
const schools = buildApp();

const SA = 'a5a00000-0000-4000-8000-0000000000c5';
const sa = () => token(SA, 'super_admin', I.schoolA);
const principalA = `${I.principalA}@test`;
const principalB = `${I.principalB}@test`;
const BANNER = () => `src="${appBaseUrl()}/email/banner.png"`;

beforeEach(async () => {
  await seed();
  sendEmail.mockReset().mockImplementation(async () => 'sent');
  (emailService.isEmailConfigured as jest.Mock).mockImplementation(() => true);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password, two_factor_required)
     VALUES ($1, NULL, 'sa-voice@test', 'x', 'super_admin', 'Super', 'Admin', true, 'subject', false, false)`, [SA]);
  await pool.query(`INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (80000) ON CONFLICT (id) DO NOTHING`);
});
afterAll(async () => { await pool.end(); });

/** Both seeded schools on a trial plan, and an announcement to trial schools: two principals. */
async function announcement(): Promise<string> {
  for (const school of [I.schoolA, I.schoolB]) {
    const res = await request(platform).post('/api/super-admin/subscriptions').set('Authorization', sa()).send({ school_id: school, plan: 'trial' });
    expect(res.status).toBe(201);
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO platform_announcements (title, body, type, target_plans, created_by)
     VALUES ('Fees & dues <update>', $1, 'info', ARRAY['trial'], $2) RETURNING id`,
    ['Fees & dues are <b>due</b> on Friday.\nBring your receipt.\n\nThank you.<script>alert(1)</script>', SA]);
  return rows[0].id;
}
const publish = (id: string) => request(platform).post(`/api/super-admin/announcements/${id}/publish`).set('Authorization', sa());
const auditMeta = async () => (await pool.query<{ metadata: Record<string, unknown> }>(
  `SELECT metadata FROM platform_audit_logs WHERE action_type = 'ANNOUNCEMENT_PUBLISHED'`)).rows.map(r => r.metadata);

describe('publishing a platform announcement', () => {
  it('emails every principal on the layout, with clean text, and counts what SendGrid accepted', async () => {
    const res = await publish(await announcement());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ recipients_count: 2, emails_sent: 2 });

    expect(sendEmail.mock.calls.map(c => c[0]).sort()).toEqual([principalA, principalB].sort());
    const [, subject, text, html] = sendEmail.mock.calls[0] as [string, string, string, string];
    expect(subject).toBe('[Chronix Edu] [INFO] — Fees & dues <update>');
    // The text part is plain text: no tags, no script, and no escaping left in it.
    expect(text).toBe('Fees & dues are due on Friday.\nBring your receipt.\n\nThank you.');
    // The HTML part escapes it for itself and keeps its shape, on the layout.
    expect(html).toContain('<h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">Fees &amp; dues &lt;update&gt;</h2>');
    expect(html).toContain('<p>Fees &amp; dues are due on Friday.<br>Bring your receipt.</p>\n<p>Thank you.</p>');
    expect(html).not.toMatch(/<b>|<script/);
    expect(html).toContain(BANNER());
    expect(await auditMeta()).toEqual([expect.objectContaining({ recipients_count: 2, emails_sent: 2 })]);
  });

  it('says how many SendGrid accepted when one is refused, rather than "sent to 2"', async () => {
    sendEmail.mockImplementation(async (to: string) => (to === principalB ? 'queued' : 'sent'));
    const res = await publish(await announcement());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ recipients_count: 2, emails_sent: 1 });
    expect(await auditMeta()).toEqual([expect.objectContaining({ recipients_count: 2, emails_sent: 1 })]);
  });

  it('counts none sent when email is not configured on the server', async () => {
    (emailService.isEmailConfigured as jest.Mock).mockImplementation(() => false);
    const res = await publish(await announcement());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ recipients_count: 2, emails_sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('the test email from Settings → Notifications', () => {
  const send = () => request(schools).post(`/api/schools/${I.schoolA}/notifications/test-email`).set('Authorization', tokens.principalA());

  it('comes on the layout and says it was sent when SendGrid accepted it', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(`Test email sent to ${principalA}`);
    const [to, subject, text, html] = sendEmail.mock.calls[0] as [string, string, string, string];
    expect({ to, subject }).toEqual({ to: principalA, subject: 'Chronix Edu — Test Email' });
    expect(text).toBe('This is a test email from Chronix Edu confirming your SendGrid configuration is working correctly.');
    expect(html).toContain(`<p>${text}</p>`);
    expect(html).toContain(BANNER());
  });

  it('says it was not sent, and why, when SendGrid refused it', async () => {
    sendEmail.mockImplementation(async () => 'queued');
    const queued = await send();
    expect(queued.status).toBe(502);
    expect(queued.body.error.code).toBe('TEST_EMAIL_NOT_SENT');
    expect(queued.body.error.message).toMatch(/was not sent\. SendGrid did not accept it\. It has been queued/);

    sendEmail.mockImplementation(async () => 'lost');
    const lost = await send();
    expect(lost.status).toBe(502);
    expect(lost.body.error.message).toMatch(/could not be queued/);
  });
});
