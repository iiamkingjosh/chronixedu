import sgMail from '@sendgrid/mail';
import { logger } from '../config/logger';

const apiKey = process.env.SENDGRID_API_KEY;
if (apiKey) sgMail.setApiKey(apiKey);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'no-reply@chronixedu.com';

/** Returns true if SENDGRID_API_KEY is configured and emails will actually be sent. */
export function isEmailConfigured(): boolean {
  return !!apiKey;
}

/** Sends an email via SendGrid. No-ops (logs only) when SENDGRID_API_KEY is not configured. */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!apiKey) return;
  try {
    await sgMail.send({ to, from: FROM_EMAIL, subject, text });
  } catch (err) {
    logger.error('sendgrid_email_failed', { to, subject, error: err instanceof Error ? err.message : err });
  }
}
