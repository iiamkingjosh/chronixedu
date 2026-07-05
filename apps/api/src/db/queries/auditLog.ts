import pool from '../client';
import type { SupportSessionContext } from '../../middleware/auth';

interface AuditLogEntry {
  schoolId: string;
  userId: string;
  actionType: string;
  entity: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  supportSession?: SupportSessionContext;
}

export async function logAudit(entry: AuditLogEntry): Promise<void> {
  // When a support session is active, the action was taken by a platform admin
  // impersonating a school user. Merge attribution into new_value so the real
  // actor is always recoverable from the audit record without a schema change.
  const newValue = entry.supportSession
    ? {
        ...(entry.newValue !== null && entry.newValue !== undefined && typeof entry.newValue === 'object'
          ? (entry.newValue as object)
          : {}),
        _support: {
          performed_by_admin: entry.supportSession.realAdminId,
          support_session_id: entry.supportSession.sessionId,
        },
      }
    : entry.newValue;

  await pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.schoolId, entry.userId, entry.actionType, entry.entity, entry.entityId ?? null, entry.oldValue ?? null, newValue ?? null]
  );
}

export async function logSettingsChange(
  schoolId: string,
  userId: string,
  field: string,
  oldValue: unknown,
  newValue: unknown
): Promise<void> {
  await logAudit({
    schoolId,
    userId,
    actionType: 'SETTINGS_CHANGE',
    entity: 'school_settings',
    entityId: schoolId,
    oldValue: { field, value: oldValue },
    newValue: { field, value: newValue },
  });
}
