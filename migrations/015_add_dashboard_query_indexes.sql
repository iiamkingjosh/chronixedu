-- Indexes derived from EXPLAIN ANALYZE on dashboard/teacher-activity queries
-- (db/queries/dashboard.ts, db/queries/auditLog.ts). Each addresses a
-- Seq Scan whose filter predicate was not covered by an existing index:
--
--   * scores      WHERE school_id = $1 AND term_id = $2
--                  (getDashboardStats school_average, getTeacherActivity
--                   last_entry, getStudentsInClassWithAverages)
--   * users       WHERE school_id = $1 AND role = $2
--                  (getTeacherActivity teacher list, dashboard teacher count)
--   * audit_logs  WHERE school_id = $1 AND action_type = $2 ORDER BY created_at DESC
--                  (getTeacherNotifications)
--
-- Run after migration 014.

BEGIN;

CREATE INDEX idx_scores_school_term ON scores (school_id, term_id);
CREATE INDEX idx_users_school_role  ON users (school_id, role);
CREATE INDEX idx_audit_logs_school_action_created ON audit_logs (school_id, action_type, created_at DESC);

COMMIT;
