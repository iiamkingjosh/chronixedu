-- One score per student per assessment component per term.
-- Required for INSERT ... ON CONFLICT upsert in the score entry API.
-- Also adds a unique constraint to result_status (student_id, term_id) so
-- there is at most one status row per student per term.

BEGIN;

ALTER TABLE scores
  ADD CONSTRAINT scores_student_term_component_unique
  UNIQUE (student_id, term_id, component_id);

ALTER TABLE result_status
  ADD CONSTRAINT result_status_student_term_unique
  UNIQUE (student_id, term_id);

COMMIT;
