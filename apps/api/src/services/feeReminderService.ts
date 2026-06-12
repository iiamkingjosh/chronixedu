import * as cron from 'node-cron';
import { listSchoolsWithCurrentTerm } from '../db/queries/analytics';
import { getOutstandingBalances, OutstandingBalanceRow } from '../db/queries/fees';
import { getParentsForStudent } from '../db/queries/parents';
import { createNotification } from '../db/queries/notifications';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';
import { sendEmail } from './emailService';
import { sendTermiiSms } from './termiiService';
import { logger } from '../config/logger';

const REMINDER_TYPE = 'fee_reminder';

function formatNaira(amount: number): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildReminderMessage(row: OutstandingBalanceRow): { title: string; body: string } {
  const title = 'Fee payment reminder';
  const body = `${row.first_name} ${row.last_name} has an outstanding balance of ${formatNaira(row.balance)} for this term. Please make payment as soon as possible.`;
  return { title, body };
}

/** Sends fee reminders (in-app + email + SMS) for every outstanding invoice in a school/term. Returns the number of parents notified. */
export async function sendFeeRemindersForSchool(schoolId: string, termId: string): Promise<number> {
  const balances = await getOutstandingBalances(schoolId, termId);
  let remindersSent = 0;

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

      if (parent.phone) {
        if (await hasReachedSmsLimit(parent.parent_id)) {
          await insertNotificationLog({ school_id: schoolId, user_id: parent.parent_id, channel: 'sms', type: REMINDER_TYPE, status: 'throttled' });
        } else {
          const sent = await sendTermiiSms(schoolId, parent.phone, body);
          await insertNotificationLog({ school_id: schoolId, user_id: parent.parent_id, channel: 'sms', type: REMINDER_TYPE, status: sent ? 'sent' : 'failed' });
        }
      }

      remindersSent++;
    }
  }

  return remindersSent;
}

/** Runs fee reminders for every school with a current term, skipping any school that errors. */
export async function runFeeReminders(): Promise<void> {
  const schools = await listSchoolsWithCurrentTerm();
  for (const { school_id, term_id } of schools) {
    try {
      await sendFeeRemindersForSchool(school_id, term_id);
    } catch (err) {
      logger.error('fee_reminders_failed', { schoolId: school_id, error: err instanceof Error ? err.message : err });
    }
  }
}

let task: cron.ScheduledTask | null = null;

/** Starts the weekly fee reminder job (every Monday at 08:00). */
export function startFeeReminderCron(): void {
  if (task) return;
  task = cron.schedule('0 8 * * 1', () => {
    runFeeReminders().catch(err => {
      logger.error('fee_reminder_cron_error', { error: err instanceof Error ? err.message : err });
    });
  });
}

export function stopFeeReminderCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
