import * as cron from 'node-cron';
import pool from '../db/client';
import { logger } from '../config/logger';
import { registerCron, markCronRun } from './cronTracker';

const CRON_NAME = 'trial-expiry-check';

registerCron(CRON_NAME, '0 9 * * *', 'Suspends schools whose trial subscription has expired');

/** Returns a real super_admin user id to attribute system-generated audit log entries to. */
async function getSystemAdminId(): Promise<string | null> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** Suspends every subscription (and its school) whose trial has expired. Returns the number suspended. */
export async function runTrialExpiryCheck(): Promise<number> {
  const expired = await pool.query<{ id: string; school_id: string; trial_ends_at: string }>(
    `SELECT id, school_id, trial_ends_at
     FROM platform_subscriptions
     WHERE subscription_status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW()`
  );

  if (expired.rows.length === 0) {
    console.log('[trial-expiry-cron] Suspended 0 expired trials');
    return 0;
  }

  const systemAdminId = await getSystemAdminId();

  for (const row of expired.rows) {
    await pool.query(
      `UPDATE platform_subscriptions SET subscription_status = 'suspended', updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
    await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [row.school_id]);

    if (systemAdminId) {
      await pool.query(
        `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata)
         VALUES ($1, $2, $3, $4)`,
        [
          systemAdminId,
          'TRIAL_EXPIRED_AUTO_SUSPEND',
          row.school_id,
          JSON.stringify({ trial_ends_at: row.trial_ends_at, auto_suspended: true, subscription_id: row.id }),
        ]
      );
    }
  }

  console.log(`[trial-expiry-cron] Suspended ${expired.rows.length} expired trials`);
  return expired.rows.length;
}

let task: cron.ScheduledTask | null = null;

/** Starts the daily trial-expiry check job (every day at 09:00). */
export function startSubscriptionCron(): void {
  if (task) return;
  task = cron.schedule('0 9 * * *', () => {
    runTrialExpiryCheck()
      .then(() => markCronRun(CRON_NAME, 'success'))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('trial_expiry_cron_error', { error: message });
        markCronRun(CRON_NAME, 'error', message);
      });
  });
}

export function stopSubscriptionCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
