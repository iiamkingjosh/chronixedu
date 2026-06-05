import pool from '../client';

interface AuditLogEntry {
  schoolId: string;
  userId: string;
  actionType: string;
  entity: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export async function logAudit(entry: AuditLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.schoolId, entry.userId, entry.actionType, entry.entity, entry.entityId ?? null, entry.oldValue ?? null, entry.newValue ?? null]
  );
}
