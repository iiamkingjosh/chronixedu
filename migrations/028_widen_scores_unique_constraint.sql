-- Widens the scores uniqueness key to include subject_id. The old key
-- (student_id, term_id, component_id) let two different subjects that
-- resolve to the same assessment component (a school-wide default grading
-- scheme, or a class-level config with no subject_id) collide on one row:
-- the second subject's score silently overwrote the first's, misattributed
-- under whichever subject wrote last, with no conflict error.
--
-- Safe to widen with no backfill: the old constraint already guarantees
-- zero duplicates on (student_id, term_id, component_id), and adding a
-- column to a UNIQUE constraint only relaxes it — it can never reject a
-- row that previously existed.

BEGIN;

ALTER TABLE scores
  DROP CONSTRAINT scores_student_term_component_unique;

ALTER TABLE scores
  ADD CONSTRAINT scores_student_subject_term_component_unique
  UNIQUE (student_id, subject_id, term_id, component_id);

COMMIT;
