-- 044: derive platform_subscriptions.amount_naira from a flat rate × the school's
-- current student count, instead of a super_admin typing a number.
--
-- Scope, deliberately narrow: schema and computation only. No checkout flow, no
-- payment gateway, no super-admin UI change. Chronix Edu bills schools a flat
-- platform amount today (migration 017); this migration makes that amount a
-- function of student_count, because schools vary widely in size and a flat fee
-- is not what's being priced. The rate itself, and any trial/plan-specific
-- carve-out, are business decisions nobody has made yet — this migration does not
-- guess at them. price_per_student_kobo starts unset on purpose; every write to
-- platform_subscriptions fails loudly until it is configured, rather than
-- silently deriving ₦0.00 or NULL (doctrine 7: an unenforced or silently-wrong
-- invariant is worse than an explicit failure).
--
-- Kobo for the rate, per doctrine 11 ("New money columns should be bigint kobo"),
-- even though amount_naira itself predates that doctrine and stays numeric(12,2)
-- naira — changing its type is a separate, unrelated migration.
--
-- "Replace, not override" (this task's own scope decision): amount_naira becomes
-- fully derived. A BEFORE INSERT OR UPDATE trigger recomputes and overwrites it on
-- every write, so no caller — including the API pool, which connects as table
-- owner and bypasses RLS per doctrine 2 — can make it diverge from
-- rate × student_count. There is no code path left that sets amount_naira by hand.
--
-- Derived values go stale silently unless something invalidates them (doctrine 8's
-- theme, one level up: a value can misrepresent *whether* it's current, not just
-- *what* it is). student_count is not a column on platform_subscriptions — it's
-- COUNT(*) on students — so adding or removing a student doesn't touch the
-- subscription row on its own. A second trigger on students re-touches the
-- matching platform_subscriptions row on every INSERT/DELETE, which re-fires the
-- first trigger and keeps amount_naira current. school_id on students is never
-- updated by any existing route, so UPDATE is deliberately not covered here; if
-- that changes, extend this trigger's event list in its own migration.
--
-- 'trial' plan is ₦0 regardless of student count — explicit decision, not left to
-- the formula. See the trigger function below for the reasoning and the existing
-- MRR precedent it matches. A non-trial school with zero students still computes
-- to ₦0.00 from the formula itself, which is a different thing from trial's ₦0
-- and is not specially handled — it's what rate × 0 honestly is.

CREATE TABLE IF NOT EXISTS platform_pricing_config (
  -- Singleton: one platform-wide flat rate. id is always `true` so a second
  -- INSERT collides on the primary key instead of silently creating a second,
  -- ambiguous rate.
  id boolean PRIMARY KEY DEFAULT true,
  price_per_student_kobo bigint NOT NULL CHECK (price_per_student_kobo > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_pricing_config_singleton CHECK (id)
);

COMMENT ON TABLE platform_pricing_config IS
  'Singleton. The flat platform rate charged per enrolled student, in kobo. Empty until a super_admin sets it; platform_subscriptions writes fail until then (see migration 044).';

ALTER TABLE platform_pricing_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_pricing_config_super_admin ON platform_pricing_config;
CREATE POLICY platform_pricing_config_super_admin ON platform_pricing_config
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'role')::text = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON platform_pricing_config TO authenticated, service_role;

-- Recomputes amount_naira on every write to platform_subscriptions. Whatever the
-- caller passed for amount_naira is discarded; this is the only path that sets it.
--
-- 'trial' is always ₦0, explicit business decision, not the formula's default: a
-- trial school owes nothing regardless of student count. This also matches
-- apps/api/src/db/queries/platformRevenue.ts, which already excludes 'trial' from
-- PLANS and therefore from MRR — trial has never contributed revenue; this makes
-- amount_naira stop *displaying* a would-be charge for a plan that was never billed.
-- Trial rows skip the rate check entirely, so a school can be trialled before any
-- rate has ever been configured.
CREATE OR REPLACE FUNCTION compute_subscription_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rate_kobo bigint;
  current_student_count integer;
BEGIN
  IF NEW.plan = 'trial' THEN
    NEW.amount_naira := 0.00;
    RETURN NEW;
  END IF;

  SELECT price_per_student_kobo INTO rate_kobo FROM platform_pricing_config LIMIT 1;

  IF rate_kobo IS NULL THEN
    RAISE EXCEPTION 'platform_pricing_config has no rate set; amount_naira cannot be derived'
      USING HINT = 'INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (<rate>) first (migration 044).';
  END IF;

  SELECT count(*) INTO current_student_count FROM students WHERE students.school_id = NEW.school_id;

  NEW.amount_naira := ROUND((current_student_count::numeric * rate_kobo) / 100.0, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_subscriptions_compute_amount ON platform_subscriptions;
CREATE TRIGGER platform_subscriptions_compute_amount
  BEFORE INSERT OR UPDATE ON platform_subscriptions
  FOR EACH ROW EXECUTE FUNCTION compute_subscription_amount();

-- Keeps amount_naira from going stale as a school's roster changes. Touches
-- updated_at (any UPDATE re-fires the trigger above, whatever column it names) on
-- the school's subscription row, if one exists yet — a school can exist before it
-- has a platform_subscriptions row, and this is a no-op until it does.
--
-- Enrolling or withdrawing a student is a routine, unrelated operation and must
-- never fail because platform_pricing_config hasn't been set yet — that would
-- make every student CRUD path in the app depend on billing setup being
-- complete, the moment any one school has a subscription row. So the recompute
-- is best-effort: if compute_subscription_amount() raises (today, only because
-- no rate is configured), this catches it, warns, and lets the student write
-- through. amount_naira for that school stays at its last computed value until
-- a rate exists and something next writes to its subscription row.
CREATE OR REPLACE FUNCTION students_recompute_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_school uuid;
BEGIN
  affected_school := COALESCE(NEW.school_id, OLD.school_id);

  BEGIN
    UPDATE platform_subscriptions
       SET updated_at = now()
     WHERE school_id = affected_school;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'platform_subscriptions not recomputed for school % (student write proceeds regardless): %',
      affected_school, SQLERRM;
  END;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS students_recompute_subscription ON students;
CREATE TRIGGER students_recompute_subscription
  AFTER INSERT OR DELETE ON students
  FOR EACH ROW EXECUTE FUNCTION students_recompute_subscription();
