import * as cron from 'node-cron';
import sgMail from '@sendgrid/mail';
import { getPendingEmails, markEmailSent, markEmailRetryFailed, deleteQueuedEmailsOlderThan } from '../db/queries/emailQueue';
import { isEmailConfigured } from './emailService';
import { logger } from '../config/logger';
import { registerCron, markCronRun, runExclusive, CRON_TIMEZONE } from './cronTracker';

const CRON_NAME = 'email-queue-retry';
const MAX_ATTEMPTS = 5;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'no-reply@chronixedu.com';

registerCron(CRON_NAME, '*/30 * * * *', 'Retries emails that failed to send via SendGrid, up to 5 attempts');

const RETENTION_CRON_NAME = 'email-queue-retention';
const RETENTION_SCHEDULE = '15 3 * * *';

/**
 * How long a queued email is kept, whatever its status. The retry job is done with a row within
 * about two and a half hours (5 attempts, 30 minutes apart), so every row has settled long before
 * this. A week leaves time to read `last_error` when someone asks why an email never arrived; after
 * that, SendGrid's own activity log is the record.
 *
 * Until 2 Oct 2026 nothing deleted a queued email. The queue held 1,993 rows, the oldest 104 days old,
 * and 1,954 of them were welcome emails with a temporary password in the body (SECURITY.md Round 29).
 * Rows still `pending` after a week are deleted too: the retry job has not run them for a week (for
 * example, email switched off), and keeping them would rebuild the same store.
 */
export const EMAIL_QUEUE_RETENTION_DAYS = 7;

registerCron(RETENTION_CRON_NAME, RETENTION_SCHEDULE, `Deletes queued emails older than ${EMAIL_QUEUE_RETENTION_DAYS} days, whatever their status`);

/** Retries every pending queued email. Marks as failed after MAX_ATTEMPTS. */
export async function runEmailQueueRetry(): Promise<void> {
  if (!isEmailConfigured()) return;

  const pending = await getPendingEmails(MAX_ATTEMPTS);
  for (const email of pending) {
    try {
      await sgMail.send({ to: email.to_email, from: FROM_EMAIL, subject: email.subject, text: email.text_body });
      await markEmailSent(email.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markEmailRetryFailed(email.id, email.attempts + 1, MAX_ATTEMPTS, message);
      logger.error('email_queue_retry_failed', { id: email.id, to: email.to_email, attempts: email.attempts + 1, error: message });
    }
  }
}

/** Deletes queued emails older than EMAIL_QUEUE_RETENTION_DAYS and returns how many of each status went. */
export async function runEmailQueueRetention(): Promise<Record<string, number>> {
  const deleted = await deleteQueuedEmailsOlderThan(EMAIL_QUEUE_RETENTION_DAYS);
  if (deleted.pending) {
    logger.warn('email_queue_retention_dropped_pending', {
      count: deleted.pending,
      days: EMAIL_QUEUE_RETENTION_DAYS,
      reason: 'never delivered: the retry job did not send them within the retention window',
    });
  }
  logger.info('email_queue_retention', { deleted: JSON.stringify(deleted), days: EMAIL_QUEUE_RETENTION_DAYS });
  return deleted;
}

let task: cron.ScheduledTask | null = null;
let retentionTask: cron.ScheduledTask | null = null;

/** Starts the email queue retry job (every 30 minutes) and the retention job (daily, 03:15 Lagos). */
export function startEmailQueueCron(): void {
  if (!retentionTask) {
    retentionTask = cron.schedule(RETENTION_SCHEDULE, () => {
      runExclusive(RETENTION_CRON_NAME, runEmailQueueRetention)
        .then(ran => { if (ran) markCronRun(RETENTION_CRON_NAME, 'success'); })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('email_queue_retention_cron_error', { error: message });
          markCronRun(RETENTION_CRON_NAME, 'error', message);
        });
    }, { timezone: CRON_TIMEZONE });
  }
  if (task) return;
  task = cron.schedule('*/30 * * * *', () => {
    runExclusive(CRON_NAME, runEmailQueueRetry)
      .then(ran => { if (ran) markCronRun(CRON_NAME, 'success'); })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('email_queue_cron_error', { error: message });
        markCronRun(CRON_NAME, 'error', message);
      });
  }, { timezone: CRON_TIMEZONE });
}

export function stopEmailQueueCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
  if (retentionTask) {
    retentionTask.stop();
    retentionTask = null;
  }
}
