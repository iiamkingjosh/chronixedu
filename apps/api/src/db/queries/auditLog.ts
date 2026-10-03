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
  /**
   * The caller's address, clientIp(req) (X-Real-IP; CLAUDE.md, Auth), or null where there is no
   * request. REQUIRED, so the compiler refuses an audit call that does not say (3 Oct 2026). Until
   * then no audit_logs row had ever recorded one: 262 rows in production, 0 with an address, while
   * CLAUDE.md said the column went through clientIp. A request context (AsyncLocalStorage) was
   * tried first and rejected: multer resumes from stream events and loses it, so every upload's
   * audit row would have recorded null without a word.
   */
  ipAddress: string | null;
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
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, old_value, new_value, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entry.schoolId, entry.userId, entry.actionType, entry.entity, entry.entityId ?? null, entry.oldValue ?? null, newValue ?? null, entry.ipAddress]
  );
}

export async function logSettingsChange(
  schoolId: string,
  userId: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  ipAddress: string | null
): Promise<void> {
  await logAudit({
    schoolId,
    userId,
    actionType: 'SETTINGS_CHANGE',
    entity: 'school_settings',
    entityId: schoolId,
    oldValue: { field, value: oldValue },
    newValue: { field, value: newValue },
    ipAddress,
  });
}
