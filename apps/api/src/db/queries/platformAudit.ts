import type { ClientBase } from 'pg';
import pool from '../client';

/**
 * One way to write a platform_audit_logs row (3 Oct 2026). Twenty places already insert into the
 * table directly (19 in routes/superAdmin.ts, 1 in services/subscriptionService.ts); they are left
 * alone, and new code uses this, so the eventual consolidation has a target (docs/AUDIT-2026-09.md).
 *
 * ipAddress is required, as it is for logAudit: pass clientIp(req) ?? null, or null with a comment
 * where no request is the actor's own. metadata must never hold a secret, a code or a password.
 */
export interface PlatformAuditEntry {
  adminId: string;
  actionType: string;
  targetUserId?: string | null;
  targetSchoolId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress: string | null;
}

export async function logPlatformAudit(entry: PlatformAuditEntry, client?: Pick<ClientBase, 'query'>): Promise<void> {
  await (client ?? pool).query(
    `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_user_id, target_school_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.adminId,
      entry.actionType,
      entry.targetUserId ?? null,
      entry.targetSchoolId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.ipAddress,
    ]
  );
}
