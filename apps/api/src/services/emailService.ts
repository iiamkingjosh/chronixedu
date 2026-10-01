import sgMail from '@sendgrid/mail';
import { logger } from '../config/logger';
import { enqueueEmail } from '../db/queries/emailQueue';

const apiKey = process.env.SENDGRID_API_KEY;
if (apiKey) sgMail.setApiKey(apiKey);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'no-reply@chronixedu.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Chronix Edu';

/** Returns true if SENDGRID_API_KEY is configured and emails will actually be sent. */
export function isEmailConfigured(): boolean {
  return !!apiKey;
}

/** What became of one email: SendGrid accepted it; SendGrid refused it and it was written to
 *  email_queue for the retry cron; SendGrid refused it and the queue write failed too, so it is gone;
 *  or nothing was tried because SENDGRID_API_KEY is not set. Only 'sent' means it went. */
export type EmailOutcome = 'sent' | 'queued' | 'lost' | 'disabled';

/** Sends an email via SendGrid. Never throws: a refused send is logged and queued for retry, and
 *  the result says which of those happened, so a caller that tells a person "we emailed them" can
 *  tell the truth (item H2, 1 Oct 2026; it returned nothing, and callers counted that as sent). */
export async function sendEmail(to: string, subject: string, text: string): Promise<EmailOutcome> {
  if (!apiKey) return 'disabled';
  try {
    await sgMail.send({ to, from: { email: FROM_EMAIL, name: FROM_NAME }, subject, text });
    return 'sent';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('sendgrid_email_failed', { to, subject, error: message });
    try {
      await enqueueEmail(to, subject, text, message);
      return 'queued';
    } catch (queueErr) {
      logger.error('email_queue_insert_failed', { to, subject, error: queueErr instanceof Error ? queueErr.message : queueErr });
      return 'lost';
    }
  }
}
