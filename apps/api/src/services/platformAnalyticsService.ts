import * as cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import pool from '../db/client';
import { logger } from '../config/logger';
import { registerCron, markCronRun } from './cronTracker';

const CRON_NAME = 'platform-analytics';

registerCron(CRON_NAME, '0 3 * * *', 'Computes and stores a daily snapshot of platform-wide metrics');

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Counts '"level":"error"' lines in the last 500 lines of the configured log file.
 * Returns null with a note if the log file isn't accessible (e.g. logging to console only).
 */
export function getRecentErrorCount(): { error_count_24h: number | null; log_note: string | null } {
  const logFilePath = path.join(process.cwd(), 'logs', 'combined.log');
  if (!fs.existsSync(logFilePath)) {
    return { error_count_24h: null, log_note: 'Log file not accessible' };
  }
  try {
    const lines = fs.readFileSync(logFilePath, 'utf-8').trim().split('\n');
    const recentLines = lines.slice(-500);
    const errorCount = recentLines.filter(line => line.includes('"level":"error"')).length;
    return { error_count_24h: errorCount, log_note: null };
  } catch {
    return { error_count_24h: null, log_note: 'Log file not accessible' };
  }
}

/** Computes today's platform metrics and upserts them into platform_metrics_snapshots. */
export async function runPlatformAnalyticsSnapshot(): Promise<void> {
  const [totalSchoolsResult, activeSchoolsResult, totalStudentsResult, mrrResult, newSchoolsResult, churnedSchoolsResult] =
    await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools`),
      pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE is_active = true`),
      pool.query<{ count: string }>(`SELECT COUNT(*) FROM students`),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(
           CASE WHEN billing_cycle = 'monthly' THEN amount_naira
                WHEN billing_cycle = 'annual' THEN amount_naira / 12
                ELSE 0 END
         ), 0) AS total
         FROM platform_subscriptions
         WHERE subscription_status = 'active'`
      ),
      pool.query<{ count: string }>(`SELECT COUNT(*) FROM schools WHERE created_at >= date_trunc('month', NOW())`),
      pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT target_school_id) AS count
         FROM platform_audit_logs
         WHERE action_type = 'SCHOOL_SUSPENDED' AND created_at >= date_trunc('month', NOW())`
      ),
    ]);

  const { error_count_24h } = getRecentErrorCount();

  await pool.query(
    `INSERT INTO platform_metrics_snapshots
       (snapshot_date, total_schools, active_schools, total_students, total_mrr_naira, new_schools_this_month, churned_schools_this_month, api_errors_24h)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (snapshot_date) DO UPDATE SET
       total_schools = EXCLUDED.total_schools,
       active_schools = EXCLUDED.active_schools,
       total_students = EXCLUDED.total_students,
       total_mrr_naira = EXCLUDED.total_mrr_naira,
       new_schools_this_month = EXCLUDED.new_schools_this_month,
       churned_schools_this_month = EXCLUDED.churned_schools_this_month,
       api_errors_24h = EXCLUDED.api_errors_24h`,
    [
      todayDateString(),
      parseInt(totalSchoolsResult.rows[0].count, 10),
      parseInt(activeSchoolsResult.rows[0].count, 10),
      parseInt(totalStudentsResult.rows[0].count, 10),
      Number(mrrResult.rows[0].total),
      parseInt(newSchoolsResult.rows[0].count, 10),
      parseInt(churnedSchoolsResult.rows[0].count, 10),
      error_count_24h ?? 0,
    ]
  );
}

let task: cron.ScheduledTask | null = null;

/** Starts the daily platform metrics snapshot job (every day at 03:00). */
export function startPlatformAnalyticsCron(): void {
  if (task) return;
  task = cron.schedule('0 3 * * *', () => {
    runPlatformAnalyticsSnapshot()
      .then(() => markCronRun(CRON_NAME, 'success'))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('platform_analytics_cron_error', { error: message });
        markCronRun(CRON_NAME, 'error', message);
      });
  });
}

export function stopPlatformAnalyticsCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
