-- 047: the component-weight check has nothing to check once its config is gone.
--
-- trg_assessment_components_total_check (001, made DEFERRABLE INITIALLY DEFERRED by 002)
-- re-checks at COMMIT that every config touched in the transaction has components summing
-- to exactly 100. A transaction that deletes a config AND its components therefore fails:
-- the queued check for each deleted component finds its config's total at 0 and raises.
-- That made it impossible to delete a school (apps/api/scripts/delete-school-data.js,
-- docs/data-deletion-runbook.md) — measured, not theorised: the script's DB test failed
-- with "must equal 100; got 0" at COMMIT.
--
-- The rule is "a config's weights sum to 100". A config that no longer exists has no
-- weights, so the function now returns early for it — and only for it.
--
-- What this permits, enumerated (doctrine 7), and what it still forbids:
--   * PERMITS  deleting a config and all its components in one transaction.
--   * FORBIDS  emptying a config that still exists (total 0, config present -> raises).
--   * FORBIDS  a partial delete or edit that leaves an existing config's total at != 100.
--   * FORBIDS  INSERT/UPDATE into a config whose total is wrong — an INSERT into a
--             non-existent config is already refused by the config_id foreign key.
-- Nothing in the application deletes an assessment_configs row (grep: no
-- "DELETE FROM assessment_configs" under apps/api/src), so the only path this opens is the
-- deletion script's. All three cases are tested in schoolDeletion.db.test.ts.
--
-- The trigger itself is unchanged; CREATE OR REPLACE keeps it pointing at this function.

CREATE OR REPLACE FUNCTION validate_assessment_components_total() RETURNS trigger AS $$
DECLARE
  config_uuid UUID;
  total NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    config_uuid := OLD.config_id;
  ELSE
    config_uuid := NEW.config_id;
  END IF;

  IF EXISTS (SELECT 1 FROM assessment_configs WHERE id = config_uuid) THEN
    SELECT COALESCE(SUM(weight_percent), 0) INTO total
    FROM assessment_components
    WHERE config_id = config_uuid;

    IF total <> 100 THEN
      RAISE EXCEPTION 'Total weight_percent for assessment_components for config % must equal 100; got %', config_uuid, total;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.config_id IS DISTINCT FROM NEW.config_id
     AND EXISTS (SELECT 1 FROM assessment_configs WHERE id = OLD.config_id) THEN
    SELECT COALESCE(SUM(weight_percent), 0) INTO total
    FROM assessment_components
    WHERE config_id = OLD.config_id;

    IF total <> 100 THEN
      RAISE EXCEPTION 'Total weight_percent for assessment_components for config % must equal 100; got %', OLD.config_id, total;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
