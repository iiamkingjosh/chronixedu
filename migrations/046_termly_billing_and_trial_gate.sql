-- 046: termly billing, derived next-billing dates, and the vocabulary of the trial gate.
--
-- Pricing, decided 30 Sep 2026: ₦800 per student per TERM (platform_pricing_config already
-- holds 80000 kobo — unchanged here). Plans are trial, premium and enterprise; Basic is gone.
-- A pre-change check found no row holding 'basic' in either schools.subscription_tier or
-- platform_subscriptions.plan, so nothing is migrated. Plan text is not constrained in the
-- database (never has been); the API's single plan enum (services/planFeatures.ts PLANS) is
-- the gate, and a plan added there without a feature decision fails the build.
--
-- 1. billing_cycle gains 'termly', and it becomes the default. 032 created the CHECK only if
--    a constraint of that exact name did not already exist, and 001–023-era constraints were
--    partly applied by hand, so the constraint is found by what it constrains, not by name.
--    Chronix High School's row stays 'monthly' here: a migration that rewrites a customer's
--    billing terms is not a schema change. The correction is a separate, owner-run statement
--    (docs/AUDIT-2026-09.md).
--
-- 2. next_term_start(school): the start date of the school's next term — the earliest
--    terms.start_date after today in Africa/Lagos. A termly subscription is billed then.
--    DERIVED ON READ, never stored: term dates stay editable and sessions roll over, and a
--    stored copy would be wrong the moment either happened (044's header: derived values go
--    stale silently unless something invalidates them). next_billing_date is left alone.
--    NULL means "not yet known" — the normal case, since onboarding asks only for the term a
--    school starts in. The API reports that as its own state, not as a blank.
--
-- 3. The trial gate. subscription_status is unconstrained text and gains two values, used
--    only by the trial-expiry job (services/subscriptionService.ts):
--      trial      days 0–30, the day named by trial_ends_at inclusive (Africa/Lagos)
--      grace      the 14 days after it — full access, an in-app notice counting down
--      read_only  after that — every GET still works; POST/PATCH/PUT/DELETE under
--                 /api/schools/:id are refused (423 SCHOOL_READ_ONLY) and the plan's extras
--                 (analytics, sms, online_payments) are off
--    schools.is_active is NOT touched by any of it. That flag means an administrator
--    suspended the school on purpose — a different decision with its own route — and it
--    used to be set by this job too, which is how the 8 Sep suspension locked a paying
--    school out of its own records.
--
--    DECIDED, for a read-only school:
--      * fee reminders stop entirely. They ask parents to pay while online payment is off
--        and the school cannot record a payment either; a reminder nobody can act on is
--        noise sent in the school's name.
--      * the notification worker still delivers what is already queued, in-app and by
--        email. Those rows were queued while the school was writable and are about the
--        children (published results, attendance); dropping them would lose a parent
--        notification silently, which Round 14 made a rule against. SMS is off, as one of
--        the plan's extras. Nothing new is queued, because nothing can be written.
--
-- The partial index 032 made for the job still names status = 'trial' alone; it is widened
-- to the two statuses the job now reads.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'public.platform_subscriptions'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%billing_cycle%'
  LOOP
    EXECUTE format('ALTER TABLE platform_subscriptions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE platform_subscriptions
  ADD CONSTRAINT platform_subscriptions_billing_cycle_check
  CHECK (billing_cycle IN ('monthly', 'termly', 'annual'));

ALTER TABLE platform_subscriptions ALTER COLUMN billing_cycle SET DEFAULT 'termly';

CREATE OR REPLACE FUNCTION next_term_start(p_school_id uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT min(t.start_date)
    FROM terms t
   WHERE t.school_id = p_school_id
     AND t.start_date > (now() AT TIME ZONE 'Africa/Lagos')::date
$$;

COMMENT ON FUNCTION next_term_start(uuid) IS
  'The school''s next term start date after today (Africa/Lagos), or NULL when no future term is set yet. A termly subscription''s next billing date (migration 046).';

DROP INDEX IF EXISTS idx_platform_subscriptions_trial_expiry;
CREATE INDEX IF NOT EXISTS idx_platform_subscriptions_trial_expiry
  ON platform_subscriptions (trial_ends_at) WHERE subscription_status IN ('trial', 'grace');
