-- Report card storage, teacher comments per subject, and principal remarks.
-- Run after migration 003.

BEGIN;

CREATE TABLE report_cards (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term_id      UUID        NOT NULL REFERENCES terms(id),
  school_id    UUID        NOT NULL REFERENCES schools(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pdf_url      TEXT,
  is_published BOOLEAN     NOT NULL DEFAULT FALSE,
  UNIQUE (student_id, term_id)
);

CREATE TABLE report_card_comments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term_id      UUID        NOT NULL REFERENCES terms(id),
  teacher_id   UUID        NOT NULL REFERENCES users(id),
  subject_id   UUID        NOT NULL REFERENCES subjects(id),
  comment_text TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, term_id, subject_id)
);

CREATE TABLE principal_remarks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term_id     UUID        NOT NULL REFERENCES terms(id),
  author_id   UUID        NOT NULL REFERENCES users(id),
  remark_text TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_report_cards_school_term      ON report_cards (school_id, term_id);
CREATE INDEX idx_report_cards_student          ON report_cards (student_id);
CREATE INDEX idx_rcc_student_term              ON report_card_comments (student_id, term_id);
CREATE INDEX idx_principal_remarks_student_term ON principal_remarks (student_id, term_id);

COMMIT;
