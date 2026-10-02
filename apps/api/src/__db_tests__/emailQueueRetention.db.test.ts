/**
 * email_queue keeps a queued email for EMAIL_QUEUE_RETENTION_DAYS (7), whatever its status, and then
 * deletes it (SECURITY.md Round 29). Until 2 Oct 2026 nothing deleted one: production held 1,993 rows,
 * the oldest 104 days old, 1,954 of them welcome emails with a temporary password in the body.
 *
 * The assertion that matters is "the old rows are gone", which a job that deletes nothing also
 * appears to satisfy if the rows were never there (doctrine 16). So each test first shows every row
 * present, and the recent rows staying behind show the job is not simply emptying the table.
 */
import { seed, pool } from './helpers';
import { logger } from '../config/logger';
import { runEmailQueueRetention, EMAIL_QUEUE_RETENTION_DAYS } from '../services/emailQueueService';
import { getCronStatus } from '../services/cronTracker';

beforeEach(async () => { await seed(); });
afterAll(async () => { await pool.end(); });

async function queue(subject: string, status: 'pending' | 'sent' | 'failed', daysAgo: number) {
  await pool.query(
    `INSERT INTO email_queue (to_email, subject, text_body, attempts, last_attempt_at, status, created_at)
     VALUES ('someone@example.test', $1, 'body', 1, now() - make_interval(days => $2), $3, now() - make_interval(days => $2))`,
    [subject, daysAgo, status]);
}
const subjects = async () =>
  (await pool.query<{ subject: string }>(`SELECT subject FROM email_queue ORDER BY subject`)).rows.map(r => r.subject);

describe('email_queue retention', () => {
  it('keeps a week: deletes older rows whatever their status, and keeps recent ones whatever theirs', async () => {
    expect(EMAIL_QUEUE_RETENTION_DAYS).toBe(7);
    await queue('old-sent', 'sent', 8);
    await queue('old-failed', 'failed', 30);
    await queue('ancient-failed', 'failed', 104);
    await queue('new-sent', 'sent', 6);
    await queue('new-failed', 'failed', 1);
    await queue('new-pending', 'pending', 0);
    expect(await subjects()).toEqual(['ancient-failed', 'new-failed', 'new-pending', 'new-sent', 'old-failed', 'old-sent']);

    const deleted = await runEmailQueueRetention();

    expect(deleted).toEqual({ sent: 1, failed: 2 });
    expect(await subjects()).toEqual(['new-failed', 'new-pending', 'new-sent']);
  });

  it('deletes a week-old row still pending too, and says so: the retry job never sent it', async () => {
    const warn = jest.spyOn(logger, 'warn');
    await queue('stuck-pending', 'pending', 9);
    await queue('new-pending', 'pending', 2);
    expect(await subjects()).toEqual(['new-pending', 'stuck-pending']);

    const deleted = await runEmailQueueRetention();

    expect(deleted).toEqual({ pending: 1 });
    expect(await subjects()).toEqual(['new-pending']);
    expect(warn).toHaveBeenCalledWith('email_queue_retention_dropped_pending', expect.objectContaining({ count: 1, days: 7 }));
    warn.mockRestore();
  });

  it('is a registered daily job, so it runs without anyone remembering to', () => {
    expect(getCronStatus()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email-queue-retention', schedule: '15 3 * * *' }),
    ]));
  });
});
