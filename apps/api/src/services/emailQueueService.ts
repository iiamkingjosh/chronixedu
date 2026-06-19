import * as cron from 'node-cron';
import sgMail from '@sendgrid/mail';
import { getPendingEmails, markEmailSent, markEmailRetryFailed } from '../db/queries/emailQueue';
import { isEmailConfigured } from './emailService';
import { logger } from '../config/logger';
import { registerCron, markCronRun } from './cronTracker';

const CRON_NAME = 'email-queue-retry';
const MAX_ATTEMPTS = 5;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'no-reply@chronixedu.com';

registerCron(CRON_NAME, '*/30 * * * *', 'Retries emails that failed to send via SendGrid, up to 5 attempts');

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

let task: cron.ScheduledTask | null = null;

/** Starts the email queue retry job (every 30 minutes). */
export function startEmailQueueCron(): void {
  if (task) return;
  task = cron.schedule('*/30 * * * *', () => {
    runEmailQueueRetry()
      .then(() => markCronRun(CRON_NAME, 'success'))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('email_queue_cron_error', { error: message });
        markCronRun(CRON_NAME, 'error', message);
      });
  });
}

export function stopEmailQueueCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
