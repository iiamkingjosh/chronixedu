import { Resend } from 'resend';
import { logger } from '../config/logger';

/**
 * The one place an email leaves the API (19 Oct 2026: Resend, replacing SendGrid, whose credits had run
 * out). sendEmail (services/emailService.ts) and the retry job (services/emailQueueService.ts) both send
 * through deliver(), so the two can no longer differ: the retry job used to send without the sender name.
 *
 * What Resend's SDK (resend 6.32) does that this file exists to get right:
 * - It never throws for a refused email or a network failure. It answers `{ data: null, error }`. Code that
 *   counts "no exception" as sent, as the SendGrid code did, would report every refusal as sent. Only an
 *   answer carrying Resend's id is accepted.
 * - Creating a client without a key throws, so one is made only when RESEND_API_KEY is set, and only when
 *   first needed.
 * - It names a spent quota (`daily_quota_exceeded`, `monthly_quota_exceeded`) apart from a burst
 *   (`rate_limit_exceeded`). The account is shared with Chronix ERP: 100 emails a day and 3,000 a month,
 *   and one per-second limit for the whole team (advisor, 19 Oct 2026). A spent quota does not come back
 *   within the retry job's five tries, 30 minutes apart, so it is reported as its own kind and the queue
 *   holds such an email without counting a try (emailQueueService).
 */

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL;
const fromName = process.env.RESEND_FROM_NAME || 'Chronix Edu';

/**
 * How many sends this API starts per second, at most, across every caller: welcome emails, announcements,
 * fee reminders, notifications and the retry job. Announcements started 50 at once. It sits below the
 * team's limit because the ERP sends on the same account; a send refused for a burst anyway is queued.
 */
export const SENDS_PER_SECOND = 4;

/**
 * After Resend refuses for a spent quota, sends are refused here, without asking Resend, for this long; then
 * one is tried again. Asking once per email would spend the per-second budget collecting refusals, and a bulk
 * import that waits on its welcome emails would run past Cloudflare's 100-second limit on a request.
 */
export const QUOTA_HOLD_MS = 15 * 60 * 1000;

/** What became of one email at Resend. `quota` is true when it was refused because the quota is spent. */
export type Delivery =
  | { accepted: true; id: string }
  | { accepted: false; quota: boolean; error: string };

export interface OutgoingEmail { to: string; subject: string; text: string; html?: string }

let client: Resend | null = null;
let nextSlot = 0;
let quotaHeldUntil = 0;

/** True when RESEND_API_KEY is set, so emails are actually sent. */
export function isProviderConfigured(): boolean {
  return !!apiKey;
}

/** Waits for this send's turn, so sends start at most SENDS_PER_SECOND a second. The slot is taken before
 *  any await, so concurrent callers queue in the order they asked. */
function takeSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / SENDS_PER_SECOND;
  return at > now ? new Promise(resolve => setTimeout(resolve, at - now)) : Promise.resolve();
}

const QUOTA_ERRORS: readonly string[] = ['daily_quota_exceeded', 'monthly_quota_exceeded'];

/** Sends one email through Resend and says what became of it. Never throws. */
export async function deliver(email: OutgoingEmail): Promise<Delivery> {
  if (!apiKey) return { accepted: false, quota: false, error: 'not_configured: RESEND_API_KEY is not set' };
  if (Date.now() < quotaHeldUntil) {
    return { accepted: false, quota: true, error: `quota_held: Resend refused for a spent quota within the last ${QUOTA_HOLD_MS / 60000} minutes` };
  }
  await takeSlot();
  try {
    client ??= new Resend(apiKey);
    const { data, error } = await client.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    });
    if (error) {
      const described = `${error.name}${error.statusCode ? ` (${error.statusCode})` : ''}: ${error.message}`;
      const quota = QUOTA_ERRORS.includes(error.name);
      if (quota) {
        quotaHeldUntil = Date.now() + QUOTA_HOLD_MS;
        logger.error('email_quota_exhausted', { error: described, held_minutes: QUOTA_HOLD_MS / 60000 });
      }
      return { accepted: false, quota, error: described };
    }
    if (!data?.id) return { accepted: false, quota: false, error: 'no_id: Resend answered without an error or an email id' };
    return { accepted: true, id: data.id };
  } catch (err) {
    // The SDK answers rather than throws; this is for what it did not foresee. The caller logs and queues it.
    return { accepted: false, quota: false, error: `exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Test seam: forget the pacing and the quota hold, so each test starts clear. */
export function resetEmailProviderState(): void {
  nextSlot = 0;
  quotaHeldUntil = 0;
  client = null;
}
