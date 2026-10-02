import winston from 'winston';
import * as Sentry from '@sentry/node';

/**
 * Deliberate alerts: the logged conditions that should wake someone, and nothing else.
 *
 * Until 1 Oct 2026 Sentry saw only unhandled exceptions (`Sentry.expressErrorHandler`). Every
 * condition the API logs and carries on from (Redis down, mail failing, a parent notification
 * lost) was logged at error and read by nobody. Piping all of winston into Sentry would not fix
 * that: a flooded Sentry is ignored too. So this is an allow-list.
 *
 * - Only the log events named in ALERTS reach Sentry. Every other `logger.error` event is in
 *   NOT_ALERTED with the reason it is not, and `alerts.test.ts` fails on an event that is in
 *   neither, so a new failure path cannot stay silent by accident.
 * - An alert carries only the fields named for it, never the whole log line. Log lines carry
 *   addresses (`sendgrid_email_failed` has `to`), and the DPA names Sentry a sub-processor for
 *   technical data only (CLAUDE.md, Conventions).
 * - Each alert is sent at most once per THROTTLE_MS per process, grouped in Sentry by its name
 *   and environment. A Redis outage logs every ~2s; it should be one issue with a count, not
 *   thousands.
 */

/**
 * Every alert is `error`. The API project's notification rule ("Send a notification for high
 * priority issues", rule 6094724) emails on HIGH-priority issues, and on 1 Oct 2026 an
 * error-level alert was measured to trigger it 27s after it was sent. A warning is not
 * guaranteed to be rated high, so it could raise an issue that emails nobody: the silent path
 * this file exists to close.
 */
type AlertLevel = 'error';

interface AlertSpec {
  /** What has gone wrong, for the person woken. Becomes the Sentry issue title. */
  why: string;
  level: AlertLevel;
  /** The log events that raise it. Each must appear verbatim in src (alerts.test.ts). */
  events: readonly string[];
  /** The only log fields forwarded. Technical values only: never an address or a name. */
  fields: readonly string[];
}

export const ALERTS = {
  redis_unavailable: {
    why: 'Redis is unreachable: rate limits and the login lockout are OFF until it is back (fail open by design, SECURITY.md Round 19)',
    level: 'error',
    // The client's own error, the rate limiter's store, and every bestEffort() caller.
    events: [
      'redis_client_error', 'rate_limit_store_unavailable',
      'ctx_cache_unavailable', 'login_lockout_unavailable', 'must_change_password_cache_unavailable',
      'step_up_lockout_unavailable', 'token_blacklist_unavailable', 'user_active_cache_unavailable',
    ],
    fields: ['error', 'detail'],
  },
  database_ca_expiring: {
    why: 'The bundled Supabase CA expires within 90 days: when it does the API cannot connect and will not boot',
    level: 'error',
    events: ['pg_tls_ca_expiring'],
    fields: ['connection', 'notAfter', 'daysLeft'],
  },
  email_failing: {
    why: 'Sending email through SendGrid is failing: notifications and receipts are queued for retry, or lost if the queue write failed too',
    level: 'error',
    events: ['sendgrid_email_failed', 'email_queue_insert_failed', 'announcement_email_failed', 'password_reset_link_email_failed'],
    fields: ['error'],
  },
  password_reset_email_failing: {
    why: 'Supabase Auth could not send a password-reset email: the person was told to check their inbox and nothing came',
    level: 'error',
    events: ['password_reset_email_failed'],
    fields: ['status', 'error'],
  },
  notification_lost: {
    why: 'A parent or teacher notification could not be queued or delivered',
    level: 'error',
    events: [
      'parent_notification_queue_failed', 'teacher_notification_queue_failed', 'notification_worker_row_failed', 'notification_worker_error',
      'announcement_fanout_failed', 'message_notification_failed',
    ],
    fields: ['notification_type', 'error'],
  },
  payout_change_alert_failed: {
    why: "A school's payout bank details changed and the fraud alert to its principals may not have gone out",
    level: 'error',
    events: ['payout_change_alert_failed', 'payout_change_alerts_aborted'],
    fields: ['error'],
  },
  paid_plan_in_trial_status: {
    why: 'A paid subscription was found in trial status: the trial gate healed it, but something put it there',
    level: 'error',
    events: ['trial_expiry_paid_plan_in_trial_status'],
    fields: ['subscription_id', 'plan', 'status'],
  },
  unrecognised_plan_tier: {
    why: 'The feature gate met a school with no recognised plan tier and let it through',
    level: 'error',
    events: ['plan_feature_unrecognised_tier', 'plan_feature_school_not_found'],
    fields: ['tier', 'feature'],
  },
  sms_failing: {
    why: 'SMS is switched on (SMS_ENABLED=true) but texts are failing or cannot be sent',
    level: 'error',
    events: ['termii_sms_failed', 'sms_misconfigured'],
    fields: ['status', 'error', 'reason'],
  },
  cron_failed: {
    why: 'A scheduled job failed: fee reminders, the trial gate, the email retry queue, its retention or analytics did not run',
    level: 'error',
    events: [
      'trial_expiry_cron_error', 'trial_expiry_no_system_admin', 'fee_reminder_cron_error', 'fee_reminders_failed',
      'email_queue_cron_error', 'email_queue_retention_cron_error', 'platform_analytics_cron_error', 'analytics_cron_error',
    ],
    fields: ['error', 'pending'],
  },
  audit_write_failed: {
    why: 'A sensitive change was made but its audit record could not be written (CLAUDE.md doctrine 10)',
    level: 'error',
    events: [
      'audit_write_failed', 'behaviour_audit_write_failed', 'announcement_audit_write_failed',
      'payment_recorded_audit_log_failed', 'staff_bulk_import_user_create_audit_log_failed',
      'staff_bulk_import_summary_audit_log_failed', 'payment_bulk_import_summary_audit_log_failed',
      'platform_billing_payment_audit_log_failed',
    ],
    fields: ['action', 'error', 'err'],
  },
  welcome_email_not_sent: {
    why: "A new account's welcome email was not sent: the person has not been told the account exists or how to set a password",
    level: 'error',
    events: ['welcome_email_failed'],
    fields: ['stage', 'error', 'outcome', 'not_sent', 'of', 'outcomes'],
  },
  password_reset_cannot_complete: {
    why: 'Someone with a valid password-reset link still cannot set a password: the link arrived in a shape the reset page cannot read, or the login has no app account',
    level: 'error',
    events: ['password_reset_link_unreadable', 'password_reset_no_local_account'],
    fields: ['outcome', 'error_code', 'auth_user_id'],
  },
  account_cannot_sign_in: {
    why: 'A new account has no Supabase Auth login: it can never sign in, and Forgot password answers 200 and sends nothing, so nobody else would ever notice',
    level: 'error',
    events: ['welcome_email_no_login'],
    fields: ['not_sent', 'of'],
  },
  auth_account_left_behind: {
    why: "A deleted platform admin's Supabase Auth account could not be deleted: the local lockout blocks login, but the identity remains",
    level: 'error',
    events: ['platform_admin_auth_delete_failed'],
    fields: ['admin_id', 'error'],
  },
  payment_callback_url_missing: {
    why: 'API_BASE_URL is not set: Paystack sends payers back to localhost after they pay',
    level: 'error',
    events: ['api_base_url_not_configured'],
    fields: [],
  },
  platform_billing_amount_verification_failed: {
    why: "A school's Paystack payment for its own Chronix subscription verified at a different amount than it was charged for at checkout — settlement was refused rather than trusted",
    level: 'error',
    events: ['platform_billing_amount_mismatch'],
    fields: ['payment_id', 'expected_kobo', 'verified_kobo'],
  },
} as const satisfies Record<string, AlertSpec>;

export type AlertName = keyof typeof ALERTS;

/**
 * `logger.error` events deliberately NOT sent to Sentry, each with its reason. A new error
 * event must be added here or to ALERTS (alerts.test.ts).
 */
export const NOT_ALERTED: Record<string, string> = {
  unhandled_error: 'Already reaches Sentry through Sentry.expressErrorHandler; sending it here would count it twice.',
  sms_disabled: 'Not an error: SMS is off by decision since 1 Oct 2026. Logged at warn/info, listed for completeness.',
  auth_suspension_check_failed: 'Answers 503 per request when the database is unreachable; a database outage is the uptime monitor\'s job (/health runs SELECT 1).',
  must_change_password_check_failed: 'Same as auth_suspension_check_failed: a per-request database failure, covered by the uptime monitor.',
  pg_pool_idle_client_error: 'The pool discards the client and opens another; routine when the Supabase pooler restarts.',
  cron_unlock_failed: 'The advisory lock is released when its session ends; nothing stays locked.',
  email_queue_retry_failed: 'One retry of an already-queued email; the underlying SendGrid failure raises email_failing.',
  payment_receipt_notify_failed: 'The payment is recorded; only the receipt email is affected, and a SendGrid failure raises email_failing.',
  payment_receipt_notify_email_failed: 'As payment_receipt_notify_failed.',
  payment_receipt_notify_payment_not_found: 'The receipt notifier was handed a payment id that is gone; the payment path itself is unaffected.',
  students_bulk_import_results_file_failed: 'The import succeeded; only the downloadable results file is missing, and the user sees that in the app.',
  staff_bulk_import_results_file_failed: 'As students_bulk_import_results_file_failed.',
  roster_bulk_import_results_file_failed: 'As students_bulk_import_results_file_failed.',
  payment_bulk_import_results_file_failed: 'As students_bulk_import_results_file_failed.',
  analytics_snapshot_failed: 'One school\'s analytics snapshot; nothing a school relies on today, and a whole failed run raises cron_failed.',
  onboarding_set_password_link_failed: 'The operator is on the onboarding screen when it happens, gets a 502 saying so, and nothing was activated; they retry.',
  platform_billing_webhook_malformed: 'A per-request shape check (missing rawBody), same posture as an invalid Paystack signature just below it, which is not alerted either; a persistent instance shows as delivery failures on Paystack’s own dashboard first.',
};

/** A condition is sent at most once per this window per process; the next event says how many were held back. */
export const THROTTLE_MS = 15 * 60 * 1000;

const EVENT_TO_ALERT = new Map<string, AlertName>();
for (const [name, spec] of Object.entries(ALERTS) as [AlertName, AlertSpec][]) {
  for (const event of spec.events) EVENT_TO_ALERT.set(event, name);
}

const lastSent = new Map<AlertName, number>();
const heldBack = new Map<AlertName, number>();

function technical(value: unknown): unknown {
  return value instanceof Error ? value.message : value;
}

/**
 * Send the alert a log event stands for, if it stands for one and the throttle allows.
 * Returns the alert sent, or null. `now` is injectable for tests.
 */
export function alertFromLog(info: Record<string, unknown>, now: number = Date.now()): AlertName | null {
  const event = typeof info.message === 'string' ? info.message : '';
  const name = EVENT_TO_ALERT.get(event);
  if (!name) return null;

  const last = lastSent.get(name);
  if (last !== undefined && now - last < THROTTLE_MS) {
    heldBack.set(name, (heldBack.get(name) ?? 0) + 1);
    return null;
  }
  const spec: AlertSpec = ALERTS[name];
  const context: Record<string, unknown> = { log_event: event, held_back_since_last: heldBack.get(name) ?? 0 };
  for (const field of spec.fields) {
    if (info[field] !== undefined) context[field] = technical(info[field]);
  }
  lastSent.set(name, now);
  heldBack.set(name, 0);

  Sentry.withScope(scope => {
    scope.setLevel(spec.level);
    // Grouped by name AND environment: a local or test run must never fold into the production
    // issue, or the first real outage would join an old test issue and raise nothing new.
    scope.setFingerprint(['alert', name, process.env.NODE_ENV ?? 'development']);
    scope.setTag('alert', name);
    scope.setContext('alert', context);
    Sentry.captureMessage(`${name}: ${spec.why}`);
  });
  return name;
}

/** Test seam: forget what has been sent, so each test starts with the throttle open. */
export function resetAlertThrottle(): void {
  lastSent.clear();
  heldBack.clear();
}

/**
 * Winston format that hands every log line to alertFromLog and passes it on unchanged;
 * unlisted events stop there. A format, not a Transport subclass: winston's types and its
 * runtime disagree on the Transport export's name (`transport` vs `Transport`).
 */
export const alertFormat = winston.format(info => {
  try {
    alertFromLog(info as Record<string, unknown>);
  } catch {
    // silent-ok: an alert must never break logging, and there is nowhere safer to report this failure.
  }
  return info;
});
