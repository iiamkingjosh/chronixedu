import { apiFetch } from './api';
import { offlineDb } from './offlineDb';

/** True if `err` indicates the request never reached the network (vs. a server-returned error). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export async function getPendingCount(): Promise<number> {
  const [attendance, scores] = await Promise.all([
    offlineDb.offline_attendance_queue.count(),
    offlineDb.offline_score_queue.count(),
  ]);
  return attendance + scores;
}

/** Drains both offline queues, posting each entry to the API. Leaves failed entries queued for the next attempt. */
export async function processOfflineQueues(): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;

  for (const item of await offlineDb.offline_attendance_queue.toArray()) {
    try {
      await apiFetch(`/api/schools/${item.school_id}/attendance/mark`, {
        method: 'POST',
        body: JSON.stringify({ class_id: item.class_id, date: item.date, entries: item.entries }),
      });
      await offlineDb.offline_attendance_queue.delete(item.id!);
      synced++;
    } catch (err) {
      if (isNetworkError(err)) return { synced, failed: failed + 1 };
      failed++;
    }
  }

  for (const item of await offlineDb.offline_score_queue.toArray()) {
    try {
      await apiFetch(`/api/schools/${item.school_id}/scores/bulk-entry`, {
        method: 'POST',
        body: JSON.stringify({
          subject_id: item.subject_id,
          class_id: item.class_id,
          term_id: item.term_id,
          entries: item.entries,
        }),
      });
      await offlineDb.offline_score_queue.delete(item.id!);
      synced++;
    } catch (err) {
      if (isNetworkError(err)) return { synced, failed: failed + 1 };
      failed++;
    }
  }

  return { synced, failed };
}
