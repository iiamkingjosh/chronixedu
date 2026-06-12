-- School notices/announcements, optionally targeted to a specific class.
-- A NULL class_id means the notice is school-wide (visible to all students).
-- Run after migration 006.

BEGIN;

CREATE TABLE notices (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   UUID         NOT NULL REFERENCES schools(id),
  class_id    UUID         REFERENCES classes(id),
  title       TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  created_by  UUID         NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notices_school_class   ON notices (school_id, class_id);
CREATE INDEX idx_notices_school_created ON notices (school_id, created_at DESC);

COMMIT;
