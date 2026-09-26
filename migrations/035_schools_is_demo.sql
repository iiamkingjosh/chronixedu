-- 035: distinguish non-customer schools from suspended customers.
--
-- The platform analytics counted every row in `schools` and `students` regardless of
-- state, so fixture schools left behind by integration tests were reported as platform
-- scale. The obvious fix — filter on is_active — does not work, for two reasons:
--
--   1. `total_schools` would become identical to `active_schools`, since is_active is
--      the only state column. The dashboard would lose a metric rather than fix one.
--   2. It conflates a test fixture with a real customer who is currently suspended.
--      Those must be counted differently: a suspended school is still a customer and
--      still belongs in platform totals; a fixture school was never one.
--
-- is_demo marks a school as not-a-customer: test fixtures, sandbox and sales-demo
-- tenants. It is orthogonal to is_active, which stays what it was — whether a real
-- school's access is currently enabled. Analytics exclude is_demo entirely; suspension
-- continues to be expressed by is_active.
--
-- Defaults to FALSE, so every existing and future school is a real customer unless
-- explicitly marked. Marking the existing fixture schools is a separate, reviewed data
-- step — deliberately not hardcoded here, because a migration that matched school names
-- against patterns like '%Test%' would eventually catch a real school called
-- "Testimony Academy".

ALTER TABLE schools ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Analytics filter on this on every platform-level count.
CREATE INDEX IF NOT EXISTS idx_schools_is_demo ON schools (is_demo) WHERE is_demo = FALSE;
