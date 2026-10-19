import { logger } from '../config/logger';
import { enqueueEmail } from '../db/queries/emailQueue';
import { deliver, isProviderConfigured } from './emailProvider';

/** Returns true if RESEND_API_KEY is configured and emails will actually be sent. */
export function isEmailConfigured(): boolean {
  return isProviderConfigured();
}

/** What became of one email: Resend accepted it; Resend refused it and it was written to email_queue
 *  for the retry cron; Resend refused it and the queue write failed too, so it is gone; or nothing was
 *  tried because RESEND_API_KEY is not set. Only 'sent' means it went. */
export type EmailOutcome = 'sent' | 'queued' | 'lost' | 'disabled';

/** Sends an email through Resend (services/emailProvider.ts). Never throws: a refused send is logged and
 *  queued for retry, and the result says which of those happened, so a caller that tells a person "we
 *  emailed them" can tell the truth (item H2, 1 Oct 2026; it returned nothing, and callers counted that as
 *  sent). A refusal because the shared quota is spent is queued without counting a try, so it waits for
 *  the quota to come back rather than using up its five tries in two and a half hours. */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<EmailOutcome> {
  if (!isEmailConfigured()) return 'disabled';
  // An HTML part is optional; the text part always goes too. A refused send is queued as text only
  // (email_queue has no HTML column), so a retried email arrives plain but complete.
  const result = await deliver({ to, subject, text, html });
  if (result.accepted) return 'sent';
  // The quota has its own alert (email_quota_exhausted, raised by the provider), so a held email is a warning.
  if (result.quota) logger.warn('email_send_held', { to, subject, error: result.error });
  else logger.error('email_send_failed', { to, subject, error: result.error });
  try {
    await enqueueEmail(to, subject, text, result.error, result.quota ? 0 : 1);
    return 'queued';
  } catch (queueErr) {
    logger.error('email_queue_insert_failed', { to, subject, error: queueErr instanceof Error ? queueErr.message : queueErr });
    return 'lost';
  }
}
