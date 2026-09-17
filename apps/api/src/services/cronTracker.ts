import pool from '../db/client';
import { logger } from '../config/logger';

interface CronRecord {
  name: string;
  schedule: string;
  description: string;
  last_run: Date | null;
  last_status: 'success' | 'error' | 'never';
  error_message: string | null;
}

const cronRegistry = new Map<string, CronRecord>();

export function registerCron(name: string, schedule: string, description: string): void {
  cronRegistry.set(name, {
    name,
    schedule,
    description,
    last_run: null,
    last_status: 'never',
    error_message: null,
  });
}

export function markCronRun(name: string, status: 'success' | 'error', error?: string): void {
  const record = cronRegistry.get(name);
  if (record) {
    record.last_run = new Date();
    record.last_status = status;
    record.error_message = error || null;
  }
}

export function getCronStatus(): CronRecord[] {
  return Array.from(cronRegistry.values());
}

// ── Single-instance execution (AUDIT M-cron) ─────────────────────────────────
// Crons run in-process. If Railway ever runs more than one replica, every
// replica fires every job: duplicate fee-reminder SMS, duplicate parent
// notifications. A session-level Postgres advisory lock makes each run
// exclusive across replicas; a replica that can't take the lock skips the run.


/** Timezone for every cron schedule — schools operate on Lagos time, Railway runs UTC. */
export const CRON_TIMEZONE = 'Africa/Lagos';

/** Runs fn only if no other instance holds the lock for `name`. Returns true if it ran. */
export async function runExclusive(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  const client = await pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`chronixedu-cron:${name}`]
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) {
      logger.info('cron_skipped_lock_held', { cron: name });
      return false;
    }
    await fn();
    return true;
  } finally {
    if (locked) {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext($1))`, [`chronixedu-cron:${name}`])
        .catch(err => logger.error('cron_unlock_failed', { cron: name, error: (err as Error).message }));
    }
    client.release();
  }
}
