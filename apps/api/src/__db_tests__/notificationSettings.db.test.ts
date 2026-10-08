/**
 * Settings → Notifications does what it says (audit, 8 Oct 2026; Moses: "Make it work").
 *
 * The page saved each event's channels and the absence rule, and nothing read them. And a
 * low-attendance alert could never be resolved, while a new one was raised only when none was open,
 * so after a child's first alert their parents were never told again.
 */
import express from 'express';
import request from 'supertest';
import * as emailService from '../services/emailService';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import attendanceRoutes from '../routes/attendance';
import { processNotificationQueue } from '../services/notificationWorker';
import { seed, tokens, IDS as I, pool } from './helpers';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, attendanceRoutes);
app.use(errorHandler);
const base = `/api/schools/${I.schoolA}`;

let emailSpy: jest.SpyInstance;
const absent = (date: string) => request(app).post(`${base}/attendance/mark`).set('Authorization', tokens.math())
  .send({ class_id: I.jss2a, date, entries: [{ student_id: I.s1, status: 'absent' }] });
const setConfig = (config: object) => pool.query(
  `INSERT INTO school_settings (school_id, notification_config) VALUES ($1, $2::jsonb)
   ON CONFLICT (school_id) DO UPDATE SET notification_config = EXCLUDED.notification_config`, [I.schoolA, JSON.stringify(config)]);
const openAlerts = async () => (await pool.query<{ id: string }>(
  `SELECT id FROM attendance_alerts WHERE student_id = $1 AND NOT is_resolved`, [I.s1])).rows;

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  emailSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue('sent');
});
afterEach(() => emailSpy.mockRestore());
afterAll(() => pool.end());

describe("the school's absence rule", () => {
  it('is 3 absences in 7 days until the school chooses', async () => {
    expect((await absent('2026-10-05')).body.data.alerts_triggered).toBe(0);
    expect((await absent('2026-10-06')).body.data.alerts_triggered).toBe(0);
    expect((await absent('2026-10-07')).body.data.alerts_triggered).toBe(1);
  });

  it("is the school's own once chosen: 2 absences in 5 days alerts at the second", async () => {
    await setConfig({ attendance_alert: { threshold: 2, window_days: 5 } });
    expect((await absent('2026-10-01')).body.data.alerts_triggered).toBe(0);
    // Six days later: outside the 5-day window, so still one absence in it.
    expect((await absent('2026-10-07')).body.data.alerts_triggered).toBe(0);
    expect((await absent('2026-10-08')).body.data.alerts_triggered).toBe(1);
  });
});

describe('resolving an alert', () => {
  it('the principal resolves it, recorded, and the next run of absences alerts again', async () => {
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) await absent(d);
    const [alert] = await openAlerts();
    expect(alert).toBeDefined();

    expect((await request(app).patch(`${base}/attendance/alerts/${alert.id}/resolve`).set('Authorization', tokens.math())).status).toBe(403);
    const res = await request(app).patch(`${base}/attendance/alerts/${alert.id}/resolve`).set('Authorization', tokens.principalA());
    expect(res.status).toBe(200);
    expect(await openAlerts()).toEqual([]);
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action_type = 'ATTENDANCE_ALERT_RESOLVED' AND entity_id = $1`, [alert.id]);
    expect(audit.rowCount).toBe(1);

    expect((await absent('2026-10-08')).body.data.alerts_triggered).toBe(1);
  });
});

describe("each event's channels", () => {
  const queueResults = () => pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, new_value, ip_address)
     VALUES ($1, $2, 'PARENT_NOTIFICATION_QUEUED', 'result_status', $3, $4, NULL)`,
    [I.schoolA, I.principalA, I.jss2a, { term_id: I.termA, notification_type: 'results_published', student_ids: [I.s1] }]);
  const bell = async () => (await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'results_published'`, [I.parentA])).rowCount;

  it('by default, results go in the app and by email', async () => {
    await queueResults();
    await processNotificationQueue();
    expect(await bell()).toBe(1);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it('with email off for results, only the app notice goes', async () => {
    await setConfig({ events: { results_published: { in_app: true, email: false, sms: false } } });
    await queueResults();
    await processNotificationQueue();
    expect(await bell()).toBe(1);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it('with the app notice off, only the email goes', async () => {
    await setConfig({ events: { results_published: { in_app: false, email: true, sms: false } } });
    await queueResults();
    await processNotificationQueue();
    expect(await bell()).toBe(0);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});
