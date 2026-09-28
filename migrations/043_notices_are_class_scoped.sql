-- Migration 043: notices are class-scoped. `class_id` becomes NOT NULL.
--
-- `notices.class_id` was nullable, and NULL meant "school-wide". That left the product
-- with two mechanisms for one intent, with materially different delivery: an
-- announcement notifies every targeted user in-app and emails them; a school-wide notice
-- appeared on a page and told nobody. A principal had two buttons for "tell the school"
-- and nothing at the moment of posting distinguished them — so one of the two created a
-- true belief ("I've told the school") and the other created a false one, while both
-- returned success.
--
-- School-wide now has exactly one home: `announcements`, which is where the fan-out
-- lives. `notices` is the class board, which is the only thing it does that
-- `announcements` cannot.
--
-- Enumerating what this constraint forbids, separately, because a migration that reasons
-- about its operations in aggregate is what 036 did before it silenced every
-- notification:
--
--   1. INSERT with a NULL class_id. One writer exists (routes/notices.ts), and this
--      migration ships with the change that stops it sending one.
--   2. UPDATE setting class_id to NULL. There is no UPDATE path at all — notices are
--      immutable by design (create and delete, no edit), so nothing can hit this.
--   3. Existing rows holding NULL. Measured in production on 28 Sep 2026, not assumed:
--      `SELECT count(*) FROM notices` returned 0 rows in total, 0 of them school-wide.
--      The table has never been written to, because until yesterday nothing in the
--      codebase could write to it.
--
-- The guard below re-checks (3) at apply time rather than trusting that reading: a
-- migration that has been sitting in the repo while the database moved on should fail
-- loudly, not coerce rows it has never seen. If it ever fires, the rows are real
-- school-wide notices and the decision above needs revisiting — do not convert them
-- silently.
--
-- This is deliberately NOT left as "nothing writes NULL any more". A convention that
-- lives in one route file is one edit away from gone, and the failure it would
-- reintroduce is invisible: a notice that reaches a page and notifies nobody.

BEGIN;

DO $$
DECLARE orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM notices WHERE class_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply 043: % school-wide notice(s) exist. These predate the decision that notices are class-scoped; move them to announcements (which notifies) or delete them deliberately, then re-run.',
      orphan_count;
  END IF;
END $$;

ALTER TABLE notices ALTER COLUMN class_id SET NOT NULL;

COMMIT;
