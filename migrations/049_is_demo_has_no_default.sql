-- 049: schools.is_demo has no default. Whether a school is a customer is stated, never inherited.
--
-- DECISION (Moses, 1 Oct 2026): option (1) — ask at creation. Doctrine 8 applied to the instance
-- that produced it: is_demo DEFAULT FALSE made every school a customer unless someone remembered
-- otherwise, and a typo'd test school ("guyg ") was counted as a customer in every platform total.
--
-- ORDER, deliberately two commits: the code that always supplies is_demo (98b8e5d — both creation
-- paths require it, every fixture and script names it) was deployed and confirmed live FIRST.
-- Railway's pre-deploy runs this migration before the new code serves, so shipping both together
-- would have let the old code (which omitted is_demo) meet a column with no default, and school
-- creation would have failed in the gap.
--
-- NOT NULL was already in place (migration that added is_demo); it is restated so this file says
-- the whole rule. No backfill: every row holds a value (45 rows, all set, measured 1 Oct 2026),
-- and the guard below refuses to proceed if that has changed.
--
-- What this permits and forbids (doctrine 7):
--   INSERT naming is_demo ........ unchanged.
--   INSERT omitting is_demo ...... now REFUSED (not-null violation) — the point.
--   UPDATE of is_demo ............ unchanged (still allowed; reclassification is by explicit id).
--   Rows already present ......... unchanged.
-- Tested in schoolCreation.db.test.ts: an explicit insert succeeds first, then an omitted one fails.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schools WHERE is_demo IS NULL) THEN
    RAISE EXCEPTION '049: a school has no is_demo value; classify it by explicit id before dropping the default';
  END IF;
END $$;

ALTER TABLE schools ALTER COLUMN is_demo DROP DEFAULT;
ALTER TABLE schools ALTER COLUMN is_demo SET NOT NULL;
