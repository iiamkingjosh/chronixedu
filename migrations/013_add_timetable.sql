-- Timetable: per-class weekly schedule grid (day_of_week x period_number),
-- assigning a subject and teacher to each class period. Powers the admin
-- drag-and-drop builder and the read-only teacher/student views.
-- Run after migration 012.

BEGIN;

CREATE TABLE timetable_slots (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID          NOT NULL REFERENCES schools(id),
  class_id        UUID          NOT NULL REFERENCES classes(id),
  term_id         UUID          NOT NULL REFERENCES terms(id),
  day_of_week     SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  period_number   SMALLINT      NOT NULL CHECK (period_number BETWEEN 1 AND 10),
  subject_id      UUID          NOT NULL REFERENCES subjects(id),
  teacher_id      UUID          NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (class_id, term_id, day_of_week, period_number)
);

CREATE INDEX idx_timetable_slots_school_term_class   ON timetable_slots (school_id, term_id, class_id);
CREATE INDEX idx_timetable_slots_school_term_teacher ON timetable_slots (school_id, term_id, teacher_id);

COMMIT;
