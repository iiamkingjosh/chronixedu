import pool from '../db/client';
import { runExclusive } from './cronTracker';
import { createNotification } from '../db/queries/notifications';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';
import { sendEmail } from './emailService';
import { sendTermiiSms, isSmsEnabled, smsDisabledReason } from './termiiService';
import { logger } from '../config/logger';
import { schoolAllowsFeature } from './planFeatures';
import { channelsFor, loadNotificationConfig, NOTIFICATION_EVENTS, type NotificationEvent, type Channels } from './notificationSettings';

const POLL_INTERVAL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_SIZE = 50;

interface QueuedAuditRow {
  id: string;
  school_id: string;
  entity: string;
  entity_id: string | null;
  new_value: {
    student_id?: string;
    student_ids?: unknown;
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
  student_id: string;
  child_first_name: string;
}

/**
 * The students a queued row is about. Attendance and behaviour rows name one (`student_id`);
 * a results row names the whole class (`student_ids`). The worker read only the first shape,
 * so every results notice was marked processed and delivered to nobody (audit, 8 Oct 2026).
 */
export function studentIdsOf(newValue: QueuedAuditRow['new_value']): string[] {
  const ids = Array.isArray(newValue?.student_ids) ? newValue.student_ids : [];
  // Only ids that can be ids: one malformed value would fail the row's query on every poll.
  const all = [...ids, newValue?.student_id].filter((v): v is string => typeof v === 'string' && UUID.test(v));
  return [...new Set(all)];
}

function buildNotification(row: QueuedAuditRow, childFirstName: string): { type: string; title: string; body: string } {
  const notificationType = row.new_value?.notification_type ?? 'general';

  if (notificationType === 'results_published') {
    return {
      type: notificationType,
      title: 'Results published',
      body: `${childFirstName}'s results for this term have been published. Sign in to view them.`,
    };
  }

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

/** Delivers one queued notification. Returns how many parents would have been texted had SMS been on. */
async function processRow(row: QueuedAuditRow, smsOn: boolean): Promise<number> {
  const studentIds = studentIdsOf(row.new_value);
  if (studentIds.length === 0) return 0;

  // One recipient per (parent, child): a parent of two children in the class is told about
  // each. DISTINCT because parent_students has no unique (parent_id, student_id). The school
  // join keeps a row from ever reaching a student of another school.
  const { rows: parents } = await pool.query<ParentRecipient>(
    `SELECT DISTINCT u.id AS parent_id, u.email, u.phone, st.id AS student_id, su.first_name AS child_first_name
     FROM parent_students ps
     JOIN students st ON st.id = ps.student_id AND st.school_id = $2
     JOIN users su ON su.id = st.user_id
     JOIN users u ON u.id = ps.parent_id
     WHERE ps.student_id = ANY($1::uuid[])
     ORDER BY u.id, st.id`,
    [studentIds, row.school_id]
  );

  const allowsSms = await schoolAllowsFeature(row.school_id, 'sms');
  // The school's channels for this event (Settings → Notifications), read once per row. An event the
  // page does not list goes in the app and by email, as every event did before (audit, 8 Oct 2026).
  const eventType = row.new_value?.notification_type ?? 'general';
  const channels: Channels = (NOTIFICATION_EVENTS as string[]).includes(eventType)
    ? channelsFor(await loadNotificationConfig(row.school_id), eventType as NotificationEvent)
    : { in_app: true, email: true, sms: true };
  let smsNotSent = 0;
  // The payload names this parent's child only: never the class list, nor who acted for the
  // school in a support session.
  const shared: Record<string, unknown> = { ...(row.new_value ?? {}) };
  delete shared.student_ids;
  delete shared._support;

  for (const parent of parents) {
    const { type, title, body } = buildNotification(row, parent.child_first_name);
    if (channels.in_app) {
      await createNotification({
        user_id: parent.parent_id,
        type,
        title,
        body,
        payload: { entity: row.entity, entity_id: row.entity_id, ...shared, student_id: parent.student_id },
      });
    }
    if (channels.email) {
      await sendEmail(parent.email, title, body);
    }

    if (parent.phone && allowsSms && channels.sms) {
      // SMS off is a stated state, not a failure: no provider call and no
      // notification_logs row per parent — the batch logs one line instead.
      if (!smsOn) {
        smsNotSent++;
      } else if (await hasReachedSmsLimit(parent.parent_id)) {
        await insertNotificationLog({
          school_id: row.school_id,
          user_id: parent.parent_id,
          channel: 'sms',
          type,
          status: 'throttled',
        });
      } else {
        const outcome = await sendTermiiSms(row.school_id, parent.phone, body);
        if (outcome === 'disabled') {
          smsNotSent++;
        } else {
          await insertNotificationLog({
            school_id: row.school_id,
            user_id: parent.parent_id,
            channel: 'sms',
            type,
            status: outcome,
          });
        }
      }
    }
  }
  return smsNotSent;
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

  const smsOn = isSmsEnabled();
  let smsNotSent = 0;
  for (const row of rows) {
    try {
      smsNotSent += await processRow(row, smsOn);
      await pool.query(`UPDATE audit_logs SET processed_at = NOW() WHERE id = $1`, [row.id]);
    } catch (err) {
      logger.error('notification_worker_row_failed', { auditLogId: row.id, error: err instanceof Error ? err.message : err });
    }
  }
  // One line per batch that delivered something — never per parent, and not every 30s idle poll.
  if (!smsOn && rows.length > 0) {
    logger.info('sms_disabled', { run: 'notification_worker', notifications: rows.length, sms_not_sent: smsNotSent, reason: smsDisabledReason() });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the background worker that drains the parent-notification queue every 30 seconds. */
export function startNotificationWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    runExclusive('notification-worker', processNotificationQueue).catch(err => {
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
