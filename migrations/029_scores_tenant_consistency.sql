-- Migration 029: tenant-consistency trigger on scores (AUDIT H-1, defence in depth).
--
-- Migration 028 widened the unique key to include subject_id, and the score
-- routes now check enrollment and component ownership. This trigger enforces
-- the same invariant in the database: a score row's school must match the
-- student's, the subject's and the component config's school, so a bug in any
-- future write path cannot attach one school's score to another school's data.

BEGIN;

CREATE OR REPLACE FUNCTION scores_enforce_tenant_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'score school_id does not match student school' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subjects WHERE id = NEW.subject_id AND school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'score school_id does not match subject school' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM assessment_components ac
    JOIN assessment_configs cfg ON cfg.id = ac.config_id
    WHERE ac.id = NEW.component_id AND cfg.school_id = NEW.school_id
  ) THEN
    RAISE EXCEPTION 'score school_id does not match component school' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scores_tenant_consistency ON scores;
CREATE TRIGGER trg_scores_tenant_consistency
  BEFORE INSERT OR UPDATE OF school_id, student_id, subject_id, component_id ON scores
  FOR EACH ROW EXECUTE FUNCTION scores_enforce_tenant_consistency();

COMMIT;
