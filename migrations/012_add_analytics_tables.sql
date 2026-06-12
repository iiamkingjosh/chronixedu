-- Analytics: nightly snapshots of school performance, attendance, and fee
-- collection, used to power the principal analytics dashboard with trend
-- comparisons over time.
-- Run after migration 011.

BEGIN;

CREATE TABLE school_analytics_snapshots (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           UUID          NOT NULL REFERENCES schools(id),
  term_id             UUID          NOT NULL REFERENCES terms(id),
  snapshot_date       DATE          NOT NULL DEFAULT CURRENT_DATE,
  overall_performance JSONB         NOT NULL,
  subject_performance JSONB         NOT NULL,
  attendance_summary  JSONB         NOT NULL,
  fee_collection      JSONB         NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, term_id, snapshot_date)
);

CREATE INDEX idx_analytics_snapshots_school_term ON school_analytics_snapshots (school_id, term_id, snapshot_date DESC);

COMMIT;
