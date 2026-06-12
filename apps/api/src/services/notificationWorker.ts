import pool from '../db/client';
import { createNotification } from '../db/queries/notifications';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';
import { sendEmail } from './emailService';
import { sendTermiiSms } from './termiiService';
import { logger } from '../config/logger';

const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;

interface QueuedAuditRow {
  id: string;
  school_id: string;
  entity: string;
  entity_id: string | null;
  new_value: {
    student_id?: string;
    notification_type?: string;
    severity?: string;
    incident_type?: string;
    [key: string]: unknown;
  } | null;
}

interface ParentRecipient {
  parent_id: string;
  email: string;
  phone: string | null;
}

function buildNotification(row: QueuedAuditRow): { type: string; title: string; body: string } {
  const notificationType = row.new_value?.notification_type ?? 'general';

  if (notificationType === 'behaviour_incident') {
    const title = row.new_value?.severity === 'suspension' ? 'Suspension notice' : 'Behaviour incident reported';
    const body = `A behaviour incident (${row.new_value?.incident_type ?? 'incident'}) was recorded for your child.`;
    return { type: notificationType, title, body };
  }

  if (notificationType === 'low_attendance') {
    return {
      type: notificationType,
      title: 'Attendance alert',
      body: 'Your child has recorded several recent absences. Please check their attendance record.',
    };
  }

  return { type: notificationType, title: 'School notification', body: 'You have a new notification from your school.' };
}

async function processRow(row: QueuedAuditRow): Promise<void> {
  const studentId = row.new_value?.student_id;
  if (!studentId) return;

  const { rows: parents } = await pool.query<ParentRecipient>(
    `SELECT u.id AS parent_id, u.email, u.phone
     FROM parent_students ps
     JOIN users u ON u.id = ps.parent_id
     WHERE ps.student_id = $1`,
    [studentId]
  );

  const { type, title, body } = buildNotification(row);

  for (const parent of parents) {
    await createNotification({
      user_id: parent.parent_id,
      type,
      title,
      body,
      payload: { entity: row.entity, entity_id: row.entity_id, ...row.new_value },
    });
    await sendEmail(parent.email, title, body);

    if (parent.phone) {
      if (await hasReachedSmsLimit(parent.parent_id)) {
        await insertNotificationLog({
          school_id: row.school_id,
          user_id: parent.parent_id,
          channel: 'sms',
          type,
          status: 'throttled',
        });
      } else {
        const sent = await sendTermiiSms(row.school_id, parent.phone, body);
        await insertNotificationLog({
          school_id: row.school_id,
          user_id: parent.parent_id,
          channel: 'sms',
          type,
          status: sent ? 'sent' : 'failed',
        });
      }
    }
  }
}

export async function processNotificationQueue(): Promise<void> {
  const { rows } = await pool.query<QueuedAuditRow>(
    `SELECT id, school_id, entity, entity_id, new_value
     FROM audit_logs
     WHERE action_type IN ('PARENT_NOTIFICATION_QUEUED', 'PARENT_NOTIFICATION_SENT')
       AND processed_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [BATCH_SIZE]
  );

  for (const row of rows) {
    try {
      await processRow(row);
      await pool.query(`UPDATE audit_logs SET processed_at = NOW() WHERE id = $1`, [row.id]);
    } catch (err) {
      logger.error('notification_worker_row_failed', { auditLogId: row.id, error: err instanceof Error ? err.message : err });
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the background worker that drains the parent-notification queue every 30 seconds. */
export function startNotificationWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    processNotificationQueue().catch(err => {
      logger.error('notification_worker_error', { error: err instanceof Error ? err.message : err });
    });
  }, POLL_INTERVAL_MS);
}

export function stopNotificationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
