import * as cron from 'node-cron';
import pool from '../db/client';
import { logger } from '../config/logger';
import { registerCron, markCronRun, runExclusive, CRON_TIMEZONE } from './cronTracker';

const CRON_NAME = 'trial-expiry-check';

registerCron(CRON_NAME, '0 9 * * *', 'Suspends schools whose trial subscription has expired');

/** Returns a real super_admin user id to attribute system-generated audit log entries to. */
async function getSystemAdminId(): Promise<string | null> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/**
 * Suspends every subscription (and its school) whose trial has expired. Returns the number
 * suspended.
 *
 * Two rules, both from 8 Sep 2026: Chronix High School's plan had been changed to premium on
 * 3 Sep with subscription_status left at 'trial', this job selected on the status alone and
 * suspended it as an expired trial, and a ₦50,000 payment was later recorded against the
 * suspended row.
 *   1. A PAID plan is never suspended here, whatever its status says. A paid plan in 'trial'
 *      status is a data error — the PATCH route now refuses to write one — so this job
 *      corrects it to 'active', writes TRIAL_STATUS_CLEARED_PAID_PLAN, and logs at error so
 *      that it is seen rather than silently tidied.
 *   2. The end date is INCLUSIVE, in Africa/Lagos: a trial "ending 8 Sep" is usable through
 *      8 Sep and expires at the 09:00 run on the 9th. trial_ends_at is stored at midnight, so
 *      the old `trial_ends_at < NOW()` killed it at 09:00 on the 8th itself.
 */
export async function runTrialExpiryCheck(): Promise<number> {
  const expired = await pool.query<{ id: string; school_id: string; plan: string; trial_ends_at: string }>(
    `SELECT id, school_id, plan, trial_ends_at
     FROM platform_subscriptions
     WHERE subscription_status = 'trial'
       AND trial_ends_at IS NOT NULL
       AND (trial_ends_at AT TIME ZONE $1)::date < (NOW() AT TIME ZONE $1)::date`,
    [CRON_TIMEZONE]
  );

  if (expired.rows.length === 0) {
    logger.info('trial_expiry_check', { suspended: 0, healed: 0 });
    return 0;
  }

  const systemAdminId = await getSystemAdminId();
  if (!systemAdminId) {
    // A suspension must never happen without an audit record.
    logger.error('trial_expiry_no_system_admin', { pending: expired.rows.length });
    throw new Error('No super_admin exists to attribute trial-expiry suspensions to; nothing was suspended');
  }

  let suspended = 0;
  let healed = 0;
  for (const row of expired.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (row.plan !== 'trial') {
        // Rule 1: a paid plan is not an expired trial, whatever its status says.
        await client.query(
          `UPDATE platform_subscriptions SET subscription_status = 'active', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        await client.query(
          `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata)
           VALUES ($1, $2, $3, $4)`,
          [
            systemAdminId,
            'TRIAL_STATUS_CLEARED_PAID_PLAN',
            row.school_id,
            JSON.stringify({ plan: row.plan, trial_ends_at: row.trial_ends_at, subscription_id: row.id, corrected_to: 'active' }),
          ]
        );
        logger.error('trial_expiry_paid_plan_in_trial_status', { subscription_id: row.id, school_id: row.school_id, plan: row.plan });
        healed += 1;
      } else {
        await client.query(
          `UPDATE platform_subscriptions SET subscription_status = 'suspended', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        await client.query(`UPDATE schools SET is_active = false WHERE id = $1`, [row.school_id]);
        await client.query(
          `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata)
           VALUES ($1, $2, $3, $4)`,
          [
            systemAdminId,
            'TRIAL_EXPIRED_AUTO_SUSPEND',
            row.school_id,
            JSON.stringify({ trial_ends_at: row.trial_ends_at, auto_suspended: true, subscription_id: row.id }),
          ]
        );
        suspended += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('trial_expiry_check', { suspended, healed });
  return suspended;
}

let task: cron.ScheduledTask | null = null;

/** Starts the daily trial-expiry check job (every day at 09:00). */
export function startSubscriptionCron(): void {
  if (task) return;
  task = cron.schedule('0 9 * * *', () => {
    runExclusive(CRON_NAME, runTrialExpiryCheck)
      .then(ran => { if (ran) markCronRun(CRON_NAME, 'success'); })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('trial_expiry_cron_error', { error: message });
        markCronRun(CRON_NAME, 'error', message);
      });
  }, { timezone: CRON_TIMEZONE });
}

export function stopSubscriptionCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
