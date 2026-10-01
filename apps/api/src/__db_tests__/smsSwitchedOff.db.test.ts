/**
 * SMS is a switch (decided 1 Oct 2026: Termii is not funded; its keys are KEPT, because SMS
 * may come back).
 *
 * Before this, a key that was present sent every text to Termii, and with the account lapsed
 * each one failed: a `failed` SMS row per parent, per run, and a rejection logged nowhere. An
 * unset key did the same through `sendTermiiSms` returning false for every recipient. Halting a
 * provider turned into a stream of per-message failures read by nobody.
 *
 * Now SMS is ON only when SMS_ENABLED is "true" AND a key is set. Whether a key exists is not
 * whether to send (doctrine 8): production keeps its keys with SMS_ENABLED unset, and that is
 * the state the "off" tests below run in. Off, the sending runs skip SMS entirely — no provider
 * call, no notification_logs row — and each run logs ONE `sms_disabled` line.
 *
 * Each path is first run with SMS on, against the same parents, to show texts really are
 * sent and recorded. "No SMS row" is also what code that does nothing produces, so the
 * enabled run is what makes the disabled assertions mean anything.
 */
import express from 'express';
import request from 'supertest';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import attendanceRoutes from '../routes/attendance';
import { runFeeReminders } from '../services/feeReminderService';
import { processNotificationQueue } from '../services/notificationWorker';
import { logger } from '../config/logger';
import { seed, tokens, IDS as I, pool } from './helpers';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, attendanceRoutes);
app.use(errorHandler);

const SECOND_PARENT = '30000000-0000-4000-8000-000000000099';
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SMS_ENV = { SMS_ENABLED: process.env.SMS_ENABLED, TERMII_API_KEY: process.env.TERMII_API_KEY };

let fetchMock: jest.Mock;
let infoSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(async () => {
  await seed();
  // The seed leaves both tiers null, which the plan check logs at error; a real school has one,
  // and "no error logged" below must be about SMS, not the fixture.
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = ANY($1)`, [[I.schoolA, I.schoolB]]);
  // s1 has two parents with phones: parentA (from the seed, given a phone) and a second.
  await pool.query(`UPDATE users SET phone = '+2348011111111' WHERE id = $1`, [I.parentA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password, phone)
     VALUES ($1, $2, 'second-parent@test', 'x', 'parent', 'Second', 'Parent', true, 'subject', false, '+2348022222222')`,
    [SECOND_PARENT, I.schoolA]);
  await pool.query(
    `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact) VALUES ($1, $2, 'father', false)`,
    [SECOND_PARENT, I.s1]);

  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  global.fetch = fetchMock as unknown as typeof fetch;
  infoSpy = jest.spyOn(logger, 'info');
  errorSpy = jest.spyOn(logger, 'error');
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  setSmsEnv(ORIGINAL_SMS_ENV);
  infoSpy.mockRestore();
  errorSpy.mockRestore();
});

afterAll(() => pool.end());

function setSmsEnv(env: { SMS_ENABLED?: string; TERMII_API_KEY?: string }) {
  for (const name of ['SMS_ENABLED', 'TERMII_API_KEY'] as const) {
    const value = env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const smsOn = () => setSmsEnv({ SMS_ENABLED: 'true', TERMII_API_KEY: 'test-termii-key' });
/** Production since 1 Oct 2026: the key is still there, the switch is not set. */
const keysKeptSwitchOff = () => setSmsEnv({ SMS_ENABLED: undefined, TERMII_API_KEY: 'test-termii-key' });

const termiiCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('termii')).length;
const disabledLines = () => infoSpy.mock.calls.filter(([event]) => event === 'sms_disabled');

async function smsRows(type: string): Promise<string[]> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM notification_logs WHERE school_id = $1 AND channel = 'sms' AND type = $2 ORDER BY status`,
    [I.schoolA, type]);
  return rows.map(r => r.status);
}

async function inAppCount(type: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM notifications WHERE user_id = ANY($1) AND type = $2`, [[I.parentA, SECOND_PARENT], type]);
  return rows[0].n;
}

/** Audit rows that would claim an SMS went out. */
async function auditRowsMentioningSms(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM audit_logs
      WHERE school_id = $1 AND (action_type ILIKE '%sms%' OR coalesce(new_value::text, '') ILIKE '%sms%')`, [I.schoolA]);
  return rows[0].n;
}

async function owe() {
  await pool.query(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid')`, [I.schoolA, I.s1, I.termA]);
}

/** Three absences in a week: the third mark raises the low-attendance alert and queues it. */
async function raiseAbsenceAlert() {
  let last: request.Response | undefined;
  for (const date of ['2026-09-14', '2026-09-15', '2026-09-16']) {
    last = await request(app).post(`/api/schools/${I.schoolA}/attendance/mark`).set('Authorization', tokens.principalA())
      .send({ class_id: I.jss2a, date, entries: [{ student_id: I.s1, status: 'absent' }] });
    expect(last.status).toBe(201);
  }
  expect(last!.body.data.alerts_triggered).toBe(1); // the precondition, asserted
  return last!;
}

describe('the weekly fee-reminder run', () => {
  it('with SMS on, texts both parents and records each text as sent (the control)', async () => {
    smsOn();
    await owe();

    await runFeeReminders();

    expect(termiiCalls()).toBe(2);
    expect(await smsRows('fee_reminder')).toEqual(['sent', 'sent']);
    expect(disabledLines()).toHaveLength(0);
  });

  it('with the key kept and SMS_ENABLED unset, completes, still notifies in-app, sends no text, writes no SMS row, and logs one line', async () => {
    keysKeptSwitchOff();
    await owe();

    await expect(runFeeReminders()).resolves.toBeUndefined();

    expect(await inAppCount('fee_reminder')).toBe(2); // the run did reach both parents
    expect(termiiCalls()).toBe(0);
    expect(await smsRows('fee_reminder')).toEqual([]);
    expect(disabledLines()).toEqual([['sms_disabled', expect.objectContaining({ run: 'fee_reminders', parents_notified: 2, sms_not_sent: 2 })]]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(await auditRowsMentioningSms()).toBe(0);
  });
});

describe('an absence alert', () => {
  it('with SMS on, texts both parents and records each text as sent (the control)', async () => {
    smsOn();
    await raiseAbsenceAlert();

    await processNotificationQueue();

    expect(termiiCalls()).toBe(2);
    expect(await smsRows('low_attendance')).toEqual(['sent', 'sent']);
  });

  it('with the key kept and SMS_ENABLED unset, is delivered in-app, sends no text, writes no SMS row, and logs one line', async () => {
    keysKeptSwitchOff();
    const marked = await raiseAbsenceAlert();

    await expect(processNotificationQueue()).resolves.toBeUndefined();

    expect(await inAppCount('low_attendance')).toBe(2);
    const { rows: [queued] } = await pool.query<{ processed: boolean }>(
      `SELECT processed_at IS NOT NULL AS processed FROM audit_logs WHERE school_id = $1 AND action_type = 'PARENT_NOTIFICATION_QUEUED'`, [I.schoolA]);
    expect(queued.processed).toBe(true); // completed, not left to retry every 30s
    expect(termiiCalls()).toBe(0);
    expect(await smsRows('low_attendance')).toEqual([]);
    expect(disabledLines()).toEqual([['sms_disabled', expect.objectContaining({ run: 'notification_worker', notifications: 1, sms_not_sent: 2 })]]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(marked.body)).not.toMatch(/sms/i);
    expect(await auditRowsMentioningSms()).toBe(0);
  });

  it('switched on without a key (unset or blank) is off too, and the line says why', async () => {
    for (const key of [undefined, '  ']) {
      setSmsEnv({ SMS_ENABLED: 'true', TERMII_API_KEY: key });
      await raiseAbsenceAlert();
      await processNotificationQueue();
      await pool.query(`DELETE FROM attendance WHERE school_id = $1`, [I.schoolA]);
      await pool.query(`DELETE FROM attendance_alerts WHERE school_id = $1`, [I.schoolA]);
    }

    expect(termiiCalls()).toBe(0);
    expect(await smsRows('low_attendance')).toEqual([]);
    const lines = disabledLines();
    expect(lines).toHaveLength(2);
    for (const [, meta] of lines) expect(meta.reason).toMatch(/TERMII_API_KEY is not set/);
  });
});
