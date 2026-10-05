import * as cron from 'node-cron';
import { deletePasswordHistoryOlderThan } from '../db/queries/passwordHistory';
import { logger } from '../config/logger';
import { registerCron, markCronRun, runExclusive, CRON_TIMEZONE } from './cronTracker';
import { PASSWORD_REUSE_DAYS } from './passwordReuse';

const RETENTION_CRON_NAME = 'password-history-retention';
const RETENTION_SCHEDULE = '20 3 * * *';

registerCron(RETENTION_CRON_NAME, RETENTION_SCHEDULE, `Deletes replaced passwords older than ${PASSWORD_REUSE_DAYS} days`);

/**
 * Deletes every password_history row past the window. A change already prunes its own account's rows,
 * so this catches accounts that never change their password again: nothing older than the rule needs
 * is kept for anyone.
 */
export async function runPasswordHistoryRetention(): Promise<number> {
  const deleted = await deletePasswordHistoryOlderThan(PASSWORD_REUSE_DAYS);
  logger.info('password_history_retention', { deleted, days: PASSWORD_REUSE_DAYS });
  return deleted;
}

let retentionTask: cron.ScheduledTask | null = null;

/** Starts the retention job (daily, 03:20 Lagos). */
export function startPasswordHistoryCron(): void {
  if (retentionTask) return;
  retentionTask = cron.schedule(RETENTION_SCHEDULE, () => {
    runExclusive(RETENTION_CRON_NAME, runPasswordHistoryRetention)
      .then(ran => { if (ran) markCronRun(RETENTION_CRON_NAME, 'success'); })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('password_history_retention_cron_error', { error: message });
        markCronRun(RETENTION_CRON_NAME, 'error', message);
      });
  }, { timezone: CRON_TIMEZONE });
}

export function stopPasswordHistoryCron(): void {
  if (retentionTask) {
    retentionTask.stop();
    retentionTask = null;
  }
}
