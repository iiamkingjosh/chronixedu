import * as cron from 'node-cron';
import pool from '../db/client';
import { logger } from '../config/logger';
import { cache, schoolCacheKey } from './cacheService';
import { registerCron, markCronRun, runExclusive, CRON_TIMEZONE } from './cronTracker';

const CRON_NAME = 'trial-expiry-check';

registerCron(CRON_NAME, '0 9 * * *', 'Moves expired trials into grace, then read-only');

/** Returns a real super_admin user id to attribute system-generated audit log entries to. */
async function getSystemAdminId(): Promise<string | null> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** The days, in Africa/Lagos, that decide a trial's stage — shared by the job and the notice. */
export const GRACE_DAYS = 14;

export interface TrialExpiryResult {
  entered_grace: number;
  entered_read_only: number;
  healed: number;
}

/**
 * The trial gate (migration 046): trial through the day named by trial_ends_at, then
 * GRACE_DAYS of grace, then read-only. Runs daily at 09:00 Africa/Lagos.
 *
 *   - Never touches schools.is_active. That flag is an administrator's deliberate
 *     suspension; this job used to set it, and on 8 Sep 2026 it locked a paying school out.
 *   - Never gates a PAID plan. A paid plan found in trial, grace or read_only status is a
 *     data error (the PATCH route refuses to write one): it is corrected to 'active',
 *     audited as TRIAL_STATUS_CLEARED_PAID_PLAN and logged at error.
 *   - Each stage entered is audited — TRIAL_ENTERED_GRACE, TRIAL_ENTERED_READ_ONLY — with
 *     the dates that decided it. A missed run catches up: a trial that is already past its
 *     grace goes straight to read-only, and both stages are recorded.
 *   - The school's cached row is dropped after each change, so the gate reads the new state
 *     on the next request rather than up to five minutes later.
 */
export async function runTrialExpiryCheck(): Promise<TrialExpiryResult> {
  const due = await pool.query<{
    id: string; school_id: string; plan: string; subscription_status: string;
    trial_ends_at: string; trial_end_date: string; grace_last_day: string; target: 'grace' | 'read_only';
  }>(
    `SELECT id, school_id, plan, subscription_status, trial_ends_at,
            ((trial_ends_at AT TIME ZONE $1)::date)::text AS trial_end_date,
            ((trial_ends_at AT TIME ZONE $1)::date + $2::int)::text AS grace_last_day,
            CASE WHEN (NOW() AT TIME ZONE $1)::date > (trial_ends_at AT TIME ZONE $1)::date + $2::int
                 THEN 'read_only' ELSE 'grace' END AS target
       FROM platform_subscriptions
      WHERE subscription_status IN ('trial', 'grace', 'read_only')
        AND trial_ends_at IS NOT NULL
        AND (trial_ends_at AT TIME ZONE $1)::date < (NOW() AT TIME ZONE $1)::date`,
    [CRON_TIMEZONE, GRACE_DAYS]
  );

  const result: TrialExpiryResult = { entered_grace: 0, entered_read_only: 0, healed: 0 };
  const work = due.rows.filter(r => r.plan !== 'trial' || r.subscription_status !== r.target && r.subscription_status !== 'read_only');
  if (work.length === 0) {
    logger.info('trial_expiry_check', { ...result });
    return result;
  }

  const systemAdminId = await getSystemAdminId();
  if (!systemAdminId) {
    // A state change must never happen without an audit record.
    logger.error('trial_expiry_no_system_admin', { pending: work.length });
    throw new Error('No super_admin exists to attribute trial-gate changes to; nothing was changed');
  }

  const audit = (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, schoolId: string, action: string, metadata: object) =>
    client.query(
      `INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata) VALUES ($1, $2, $3, $4)`,
      [systemAdminId, action, schoolId, JSON.stringify(metadata)]
    );

  for (const row of work) {
    const dates = { trial_ends_at: row.trial_ends_at, trial_end_date: row.trial_end_date, grace_last_day: row.grace_last_day, subscription_id: row.id };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (row.plan !== 'trial') {
        await client.query(`UPDATE platform_subscriptions SET subscription_status = 'active', updated_at = NOW() WHERE id = $1`, [row.id]);
        await audit(client, row.school_id, 'TRIAL_STATUS_CLEARED_PAID_PLAN', { ...dates, plan: row.plan, from: row.subscription_status, corrected_to: 'active' });
        logger.error('trial_expiry_paid_plan_in_trial_status', { subscription_id: row.id, school_id: row.school_id, plan: row.plan, status: row.subscription_status });
        result.healed += 1;
      } else {
        await client.query(`UPDATE platform_subscriptions SET subscription_status = $2, updated_at = NOW() WHERE id = $1`, [row.id, row.target]);
        if (row.subscription_status === 'trial') {
          await audit(client, row.school_id, 'TRIAL_ENTERED_GRACE', { ...dates, from: 'trial', to: 'grace' });
          result.entered_grace += 1;
        }
        if (row.target === 'read_only') {
          await audit(client, row.school_id, 'TRIAL_ENTERED_READ_ONLY', { ...dates, from: 'grace', to: 'read_only' });
          result.entered_read_only += 1;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    cache.del(schoolCacheKey(row.school_id, 'data'));
  }

  logger.info('trial_expiry_check', { ...result });
  return result;
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
