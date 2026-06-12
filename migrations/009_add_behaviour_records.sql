-- Behaviour tracking: teachers/principals log incidents per student.
-- Minor/serious incidents queue a parent notification (audit-log driven,
-- matching the existing PARENT_NOTIFICATION_QUEUED pattern used for
-- attendance alerts); suspensions notify the parent immediately.
-- Run after migration 008.

BEGIN;

CREATE TYPE chronixedu_behaviour_severity AS ENUM ('minor', 'serious', 'suspension');

CREATE TABLE behaviour_records (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          UUID         NOT NULL REFERENCES schools(id),
  student_id         UUID         NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term_id            UUID         NOT NULL REFERENCES terms(id),
  class_id           UUID         NOT NULL REFERENCES classes(id),
  incident_type      TEXT         NOT NULL,
  description        TEXT,
  sanction           TEXT,
  severity           chronixedu_behaviour_severity NOT NULL,
  reported_by        UUID         NOT NULL REFERENCES users(id),
  date               DATE         NOT NULL DEFAULT CURRENT_DATE,
  parent_notified_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_behaviour_records_student ON behaviour_records (school_id, student_id);
CREATE INDEX idx_behaviour_records_class   ON behaviour_records (school_id, class_id);
CREATE INDEX idx_behaviour_records_term    ON behaviour_records (school_id, term_id);

COMMIT;
