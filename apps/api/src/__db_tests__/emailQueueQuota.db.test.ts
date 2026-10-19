/**
 * A spent quota does not use up an email's tries (19 Oct 2026, the move to Resend). The Resend account is
 * shared with Chronix ERP: 100 emails a day, 3,000 a month. The retry job gives an email five tries, 30
 * minutes apart, which is two and a half hours; a daily quota comes back once a day. Before this, every
 * refusal counted, so an email refused for the quota was marked failed long before the quota returned, and
 * "it was queued" was true and useless. Now a quota refusal records why and when, uses no try, and ends the
 * run, because every email after it would be refused for the same reason.
 *
 * The provider is replaced, so these tests decide what Resend answers; the queue code and the table are real.
 * Each "nothing changed" is preceded by the state it is compared with (doctrine 16), and each test that
 * stops early shows the email it did try.
 */
jest.mock('../services/emailProvider', () => ({ deliver: jest.fn(), isProviderConfigured: () => true }));

import { seed, pool } from './helpers';
import { deliver } from '../services/emailProvider';
import { runEmailQueueRetry } from '../services/emailQueueService';
import { sendEmail } from '../services/emailService';

const mockDeliver = deliver as jest.Mock;
const QUOTA = { accepted: false, quota: true, error: 'daily_quota_exceeded (429): You have reached your daily email sending quota' };
const BURST = { accepted: false, quota: false, error: 'rate_limit_exceeded (429): Too many requests' };

beforeEach(async () => { await seed(); mockDeliver.mockReset(); });
afterAll(async () => { await pool.end(); });

async function queue(to: string, attempts: number, minutesAgo: number) {
  await pool.query(
    `INSERT INTO email_queue (to_email, subject, text_body, attempts, last_attempt_at, status, created_at)
     VALUES ($1, 'Subject', 'Body', $2, now() - make_interval(mins => $3), 'pending', now() - make_interval(mins => $3))`,
    [to, attempts, minutesAgo]);
}
const rows = async () => (await pool.query<{ to_email: string; attempts: number; status: string; last_error: string | null }>(
  `SELECT to_email, attempts, status, last_error FROM email_queue ORDER BY created_at, to_email`)).rows;

describe('the retry job and a spent quota', () => {
  it('ends the run at the first quota refusal: that email records why, uses no try, and the rest are not asked about', async () => {
    await queue('first@example.test', 1, 30);
    await queue('second@example.test', 2, 20);
    await queue('third@example.test', 1, 10);
    expect(await rows()).toEqual([
      { to_email: 'first@example.test', attempts: 1, status: 'pending', last_error: null },
      { to_email: 'second@example.test', attempts: 2, status: 'pending', last_error: null },
      { to_email: 'third@example.test', attempts: 1, status: 'pending', last_error: null },
    ]);
    mockDeliver.mockResolvedValue(QUOTA);

    await runEmailQueueRetry();

    // The control: the oldest email was tried, so "nothing changed" below is the rule, not an idle job.
    expect(mockDeliver.mock.calls.map(([e]) => e.to)).toEqual(['first@example.test']);
    expect(await rows()).toEqual([
      { to_email: 'first@example.test', attempts: 1, status: 'pending', last_error: QUOTA.error },
      { to_email: 'second@example.test', attempts: 2, status: 'pending', last_error: null },
      { to_email: 'third@example.test', attempts: 1, status: 'pending', last_error: null },
    ]);
  });

  it('an email at its fourth try, refused for the quota run after run, stays pending, never failed', async () => {
    await queue('patient@example.test', 4, 30);
    mockDeliver.mockResolvedValue(QUOTA);
    for (let run = 0; run < 6; run++) await runEmailQueueRetry();
    expect(mockDeliver).toHaveBeenCalledTimes(6);
    expect(await rows()).toEqual([{ to_email: 'patient@example.test', attempts: 4, status: 'pending', last_error: QUOTA.error }]);
  });

  it('an ordinary refusal still uses a try on every email, and the fifth marks it failed', async () => {
    await queue('first@example.test', 1, 30);
    await queue('second@example.test', 4, 20);
    mockDeliver.mockResolvedValue(BURST);

    await runEmailQueueRetry();

    expect(mockDeliver).toHaveBeenCalledTimes(2);
    expect(await rows()).toEqual([
      { to_email: 'first@example.test', attempts: 2, status: 'pending', last_error: BURST.error },
      { to_email: 'second@example.test', attempts: 5, status: 'failed', last_error: BURST.error },
    ]);
  });

  it('an accepted email is marked sent', async () => {
    await queue('first@example.test', 3, 30);
    mockDeliver.mockResolvedValue({ accepted: true, id: 'email-id-1' });
    await runEmailQueueRetry();
    expect(await rows()).toEqual([{ to_email: 'first@example.test', attempts: 3, status: 'sent', last_error: null }]);
  });
});

describe('sendEmail writes what each refusal costs', () => {
  it('a quota refusal is queued having used no try; a burst refusal, having used one', async () => {
    expect(await rows()).toEqual([]);
    mockDeliver.mockResolvedValueOnce(QUOTA).mockResolvedValueOnce(BURST);

    await expect(sendEmail('held@example.test', 'Subject', 'Body')).resolves.toBe('queued');
    await expect(sendEmail('refused@example.test', 'Subject', 'Body')).resolves.toBe('queued');

    expect(await rows()).toEqual([
      { to_email: 'held@example.test', attempts: 0, status: 'pending', last_error: QUOTA.error },
      { to_email: 'refused@example.test', attempts: 1, status: 'pending', last_error: BURST.error },
    ]);
  });
});
