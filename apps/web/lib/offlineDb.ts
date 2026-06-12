import Dexie, { Table } from 'dexie';

export interface OfflineAttendanceEntry {
  id?: number;
  school_id: string;
  class_id: string;
  date: string;
  entries: { student_id: string; status: string }[];
  queued_at: string;
}

export interface OfflineScoreEntry {
  id?: number;
  school_id: string;
  subject_id: string;
  class_id: string;
  term_id: string;
  entries: { student_id: string; component_id: string; score: number }[];
  queued_at: string;
}

class ChronixOfflineDB extends Dexie {
  offline_attendance_queue!: Table<OfflineAttendanceEntry, number>;
  offline_score_queue!: Table<OfflineScoreEntry, number>;

  constructor() {
    super('chronixedu_offline');
    this.version(1).stores({
      offline_attendance_queue: '++id, school_id, class_id, date',
      offline_score_queue: '++id, school_id, class_id, subject_id, term_id',
    });
  }
}

export const offlineDb = new ChronixOfflineDB();
