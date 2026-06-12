-- Convert the assessment_components total-check trigger from a plain row-level
-- trigger to a DEFERRABLE INITIALLY DEFERRED constraint trigger.
--
-- Why: the original trigger fires after every individual INSERT/UPDATE/DELETE row,
-- making it impossible to replace all components in a single transaction (the
-- intermediate state after deleting any row would violate the total=100 check).
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger fires once at COMMIT instead,
-- so DELETE-all → INSERT-all within one transaction works correctly.
--
-- The trigger function itself is unchanged.

BEGIN;

DROP TRIGGER trg_assessment_components_total_check ON assessment_components;

CREATE CONSTRAINT TRIGGER trg_assessment_components_total_check
  AFTER INSERT OR UPDATE OR DELETE ON assessment_components
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_assessment_components_total();

COMMIT;
