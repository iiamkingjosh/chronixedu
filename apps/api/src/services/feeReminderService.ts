import * as cron from 'node-cron';
import { listSchoolsWithCurrentTerm } from '../db/queries/analytics';
import { getOutstandingBalances, OutstandingBalanceRow } from '../db/queries/fees';
import { getParentsForStudent } from '../db/queries/parents';
import { createNotification } from '../db/queries/notifications';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';
import { sendEmail } from './emailService';
import { sendTermiiSms, isSmsEnabled, smsDisabledReason } from './termiiService';
import { logger } from '../config/logger';
import { registerCron, markCronRun, runExclusive, CRON_TIMEZONE } from './cronTracker';
import { schoolAllowsFeature } from './planFeatures';
import { findSubscriptionGate } from '../db/queries/schools';

const CRON_NAME = 'weekly-fee-reminders';

registerCron(CRON_NAME, '0 8 * * 1', 'Sends weekly fee payment reminders to parents with outstanding balances');

const REMINDER_TYPE = 'fee_reminder';

function formatNaira(amount: number): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildReminderMessage(row: OutstandingBalanceRow): { title: string; body: string } {
  const title = 'Fee payment reminder';
  const body = `${row.first_name} ${row.last_name} has an outstanding balance of ${formatNaira(row.balance)} for this term. Please make payment as soon as possible.`;
  return { title, body };
}

interface ReminderTally {
  notified: number;
  /** Parents who would have been texted had SMS been on. */
  smsNotSent: number;
}

async function remindSchool(schoolId: string, termId: string, smsOn: boolean): Promise<ReminderTally> {
  // Decided in migration 046: a read-only school sends no fee reminders. They would ask
  // parents to pay while online payment is off and the school cannot record a payment.
  if ((await findSubscriptionGate(schoolId))?.subscription_status === 'read_only') {
    logger.info('fee_reminders_skipped_read_only', { school_id: schoolId, term_id: termId });
    return { notified: 0, smsNotSent: 0 };
  }
  const balances = await getOutstandingBalances(schoolId, termId);
  const allowsSms = await schoolAllowsFeature(schoolId, 'sms');
  const tally: ReminderTally = { notified: 0, smsNotSent: 0 };

  for (const row of balances) {
    const { title, body } = buildReminderMessage(row);
    const parents = await getParentsForStudent(row.student_id);

    for (const parent of parents) {
      await createNotification({
        user_id: parent.parent_id,
        type: REMINDER_TYPE,
        title,
        body,
        payload: { student_id: row.student_id, balance: row.balance },
      });

      await sendEmail(parent.email, title, body);

      if (parent.phone && allowsSms) {
        // SMS off is a stated state, not a failure: no provider call and no
        // notification_logs row per parent — the run logs one line instead.
        if (!smsOn) {
          tally.smsNotSent++;
        } else if (await hasReachedSmsLimit(parent.parent_id)) {
          await insertNotificationLog({ school_id: schoolId, user_id: parent.parent_id, channel: 'sms', type: REMINDER_TYPE, status: 'throttled' });
        } else {
          const outcome = await sendTermiiSms(schoolId, parent.phone, body);
          if (outcome === 'disabled') tally.smsNotSent++;
          else await insertNotificationLog({ school_id: schoolId, user_id: parent.parent_id, channel: 'sms', type: REMINDER_TYPE, status: outcome });
        }
      }

      tally.notified++;
    }
  }

  return tally;
}

/** Sends fee reminders (in-app + email, and SMS when it is switched on) for every outstanding invoice in a school/term. Returns the number of parents notified. */
export async function sendFeeRemindersForSchool(schoolId: string, termId: string): Promise<number> {
  const smsOn = isSmsEnabled();
  const { notified, smsNotSent } = await remindSchool(schoolId, termId, smsOn);
  if (!smsOn) {
    logger.info('sms_disabled', { run: 'fee_reminders', school_id: schoolId, parents_notified: notified, sms_not_sent: smsNotSent, reason: smsDisabledReason() });
  }
  return notified;
}

/** Runs fee reminders for every school with a current term, skipping any school that errors. */
export async function runFeeReminders(): Promise<void> {
  const smsOn = isSmsEnabled();
  const schools = await listSchoolsWithCurrentTerm();
  const total: ReminderTally = { notified: 0, smsNotSent: 0 };
  for (const { school_id, term_id } of schools) {
    try {
      const tally = await remindSchool(school_id, term_id, smsOn);
      total.notified += tally.notified;
      total.smsNotSent += tally.smsNotSent;
    } catch (err) {
      logger.error('fee_reminders_failed', { schoolId: school_id, error: err instanceof Error ? err.message : err });
    }
  }
  // One line for the whole run, however many schools and parents it covered.
  if (!smsOn) {
    logger.info('sms_disabled', { run: 'fee_reminders', schools: schools.length, parents_notified: total.notified, sms_not_sent: total.smsNotSent, reason: smsDisabledReason() });
  }
}

let task: cron.ScheduledTask | null = null;

/** Starts the weekly fee reminder job (every Monday at 08:00). */
export function startFeeReminderCron(): void {
  if (task) return;
  task = cron.schedule('0 8 * * 1', () => {
    runExclusive(CRON_NAME, runFeeReminders)
      .then(ran => { if (ran) markCronRun(CRON_NAME, 'success'); })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('fee_reminder_cron_error', { error: message });
        markCronRun(CRON_NAME, 'error', message);
      });
  }, { timezone: CRON_TIMEZONE });
}

export function stopFeeReminderCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
