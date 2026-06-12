import * as cron from 'node-cron';
import {
  computeOverallPerformance,
  computeSubjectPerformance,
  computeAttendanceSummary,
  upsertSnapshot,
  listSchoolsWithCurrentTerm,
  AnalyticsSnapshotRow,
} from '../db/queries/analytics';
import { getCollectionSummary } from '../db/queries/fees';
import { logger } from '../config/logger';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function generateSnapshot(
  schoolId: string,
  termId: string,
  snapshotDate: string = todayDateString()
): Promise<AnalyticsSnapshotRow> {
  const [overall_performance, subject_performance, attendance_summary, fee_collection] = await Promise.all([
    computeOverallPerformance(schoolId, termId),
    computeSubjectPerformance(schoolId, termId),
    computeAttendanceSummary(schoolId, termId),
    getCollectionSummary(schoolId, termId),
  ]);

  return upsertSnapshot(schoolId, termId, snapshotDate, {
    overall_performance,
    subject_performance,
    attendance_summary,
    fee_collection,
  });
}

export async function runNightlyAnalyticsSnapshot(): Promise<void> {
  const schools = await listSchoolsWithCurrentTerm();

  for (const { school_id, term_id } of schools) {
    try {
      await generateSnapshot(school_id, term_id);
    } catch (err) {
      logger.error('analytics_snapshot_failed', { schoolId: school_id, error: err instanceof Error ? err.message : err });
    }
  }
}

let task: cron.ScheduledTask | null = null;

/** Starts the nightly analytics snapshot job, scheduled for 02:00 server time. */
export function startAnalyticsCron(): void {
  if (task) return;
  task = cron.schedule('0 2 * * *', () => {
    runNightlyAnalyticsSnapshot().catch(err => {
      logger.error('analytics_cron_error', { error: err instanceof Error ? err.message : err });
    });
  });
}

export function stopAnalyticsCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
