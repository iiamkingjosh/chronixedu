import sgMail from '@sendgrid/mail';
import { logger } from '../config/logger';
import { enqueueEmail } from '../db/queries/emailQueue';

const apiKey = process.env.SENDGRID_API_KEY;
if (apiKey) sgMail.setApiKey(apiKey);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'no-reply@chronixedu.com';

/** Returns true if SENDGRID_API_KEY is configured and emails will actually be sent. */
export function isEmailConfigured(): boolean {
  return !!apiKey;
}

/** Sends an email via SendGrid. No-ops (logs only) when SENDGRID_API_KEY is not configured.
 *  On send failure, the email is written to email_queue for retry by the queue cron. */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!apiKey) return;
  try {
    await sgMail.send({ to, from: FROM_EMAIL, subject, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('sendgrid_email_failed', { to, subject, error: message });
    try {
      await enqueueEmail(to, subject, text, message);
    } catch (queueErr) {
      logger.error('email_queue_insert_failed', { to, subject, error: queueErr instanceof Error ? queueErr.message : queueErr });
    }
  }
}
