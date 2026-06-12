-- Daily attendance tracking and low-attendance alerts.
-- Run after migration 005.

BEGIN;

CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'excused');

CREATE TABLE attendance (
  id          UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   UUID                NOT NULL REFERENCES schools(id),
  student_id  UUID                NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id    UUID                NOT NULL REFERENCES classes(id),
  term_id     UUID                NOT NULL REFERENCES terms(id),
  date        DATE                NOT NULL,
  status      attendance_status   NOT NULL,
  marked_by   UUID                NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, class_id, date)
);

CREATE TABLE attendance_alerts (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    UUID         NOT NULL REFERENCES schools(id),
  student_id   UUID         NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  alert_type   TEXT         NOT NULL,
  triggered_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_resolved  BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_attendance_class_date_term  ON attendance (class_id, date, term_id);
CREATE INDEX idx_attendance_student_term     ON attendance (student_id, term_id);
CREATE INDEX idx_attendance_school_date      ON attendance (school_id, date);
CREATE INDEX idx_attendance_alerts_student   ON attendance_alerts (student_id);
CREATE INDEX idx_attendance_alerts_unresolved ON attendance_alerts (school_id, is_resolved);

COMMIT;
