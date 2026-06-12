-- Assignment management: teachers create assignments for a class/subject;
-- students submit work before the due date; teachers grade submissions.
-- Run after migration 007.

BEGIN;

CREATE TABLE assignments (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       UUID         NOT NULL REFERENCES schools(id),
  class_id        UUID         NOT NULL REFERENCES classes(id),
  subject_id      UUID         NOT NULL REFERENCES subjects(id),
  teacher_id      UUID         NOT NULL REFERENCES users(id),
  title           TEXT         NOT NULL,
  description     TEXT,
  due_date        TIMESTAMPTZ  NOT NULL,
  attachment_url  TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE assignment_submissions (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  UUID         NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id     UUID         NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  submitted_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  file_url       TEXT         NOT NULL,
  grade          NUMERIC(5,2),
  feedback       TEXT,
  graded_by      UUID         REFERENCES users(id),
  UNIQUE (assignment_id, student_id)
);

CREATE INDEX idx_assignments_school_class          ON assignments (school_id, class_id);
CREATE INDEX idx_assignments_teacher               ON assignments (teacher_id);
CREATE INDEX idx_assignment_submissions_assignment ON assignment_submissions (assignment_id);
CREATE INDEX idx_assignment_submissions_student    ON assignment_submissions (student_id);

COMMIT;
