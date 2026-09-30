-- 045: platform billing counts CURRENTLY ENROLLED students, not everyone ever enrolled.
--
-- 044 derived platform_subscriptions.amount_naira from rate × COUNT(*) FROM students.
-- That count is "every student who has ever been enrolled at this school" and can only
-- grow: students has no status column (no is_active, withdrawn or graduated), the only
-- DELETE FROM students is the super-admin wipe, and there is no graduation concept in
-- the API. A school in its fifth year would have been billed for five cohorts it no
-- longer teaches. No money has been collected and no rate is configured, so this is
-- fixable now without refunds; it would not be once collection exists.
--
-- THE DEFINITION. A billable student has a student_classes row for the school's CURRENT
-- academic session — academic_sessions.is_current, which migration 001's
-- one_current_session partial unique index keeps to at most one per school, and the
-- same condition apps/api/src/db/queries/students.ts uses to list a school's students.
-- No new column and no graduation feature: a graduate simply gets no student_classes
-- row for the new session and falls out of billing at rollover.
--
-- COUNT(DISTINCT student_id), not COUNT(*). student_classes has no unique constraint on
-- (student_id, session_id) — only plain indexes (migration 001) — so a student moved
-- between classes mid-session has two rows and a plain count bills them twice. That
-- missing constraint is a latent issue in its own right (nothing stops two rows for one
-- student in one session); it is recorded in docs/AUDIT-2026-09.md and deliberately not
-- added here.
--
-- NO CURRENT SESSION — decided, not left open. "No current session" and "zero students
-- enrolled" both count 0 but are different facts (doctrine 8), so a silent ₦0 is the
-- wrong default. The rule:
--   * INSERT of a paid plan for a school with no current session is REFUSED (SQLSTATE
--     BL002). There is no last computed value to keep, and a school that has not set up
--     an academic session cannot be priced; the session comes first. This is the one
--     place the recommendation ("keep the last value and warn") cannot apply, because
--     on INSERT there is no last value.
--   * UPDATE keeps amount_naira at its LAST COMPUTED VALUE and raises a WARNING — the
--     shape 044 already used for the best-effort recompute. Between sessions the last
--     known amount stands, and the academic_sessions trigger below recomputes it the
--     moment a current session exists again. The kept value may be a trial's ₦0.00 if
--     the plan was changed to paid while no session was current; the WARNING is the
--     signal, and the next rollover corrects it.
--   'trial' stays ₦0.00 before any of this, exactly as in 044.
--   Zero enrolled with a session in place is ₦0.00 from the formula: what rate × 0 is.
--
-- TRIGGERS. What changes the count is enrolment and rollover, so the recompute now fires
-- on student_classes INSERT / UPDATE / DELETE and on academic_sessions INSERT / UPDATE OF
-- is_current / DELETE. 044's AFTER INSERT OR DELETE ON students was the wrong signal —
-- creating a student row is not what makes them billable, enrolling them is — so it is
-- dropped rather than left as a third trigger firing redundant recomputes. A wipe that
-- deletes students still reaches here through the student_classes rows it deletes first.
-- Row-level, one recompute per enrolment row: a bulk enrolment of N rows does N
-- COUNT(DISTINCT)s over one school's current session. Fine at the scale of a school; a
-- statement-level trigger with transition tables is the upgrade if it ever is not.
--
-- BEST EFFORT, NARROWED. Enrolling a student must never fail because billing is not
-- configured — 044's handler exists for that, and the property survives. But 044 caught
-- WHEN OTHERS, which swallowed deadlocks and permission errors identically to the one
-- case it was written for. The no-rate exception now carries its own SQLSTATE (BL001)
-- and the recompute catches exactly that. Anything else propagates and fails the
-- enrolment write, which is right: a deadlock or a permission error is a fault, not a
-- configuration gap. BL002 never reaches the handler — it is raised only on INSERT of a
-- subscription row, and the recompute only ever UPDATEs.
--
-- ALSO: platform_pricing_config gets the service_role_bypass policy every table carries
-- (CLAUDE.md, Migrations) that 044 left out. Its sibling platform tables from 016/017
-- (platform_subscriptions, platform_audit_logs, support_sessions) do not have one
-- either; 042 declined to add theirs inside a reconciliation, and that remains a
-- separate decision. scripts/sql/rls_policy_inventory.txt is regenerated in this commit.
--
-- Nothing here recomputes existing rows. The one subscription in production (a demo
-- school, suspended, no rate configured) keeps its amount until a rate exists and
-- something writes to it — which is also how 044 left it.

-- The single definition of "billable", shared by the trigger below and by the API's
-- GET /super-admin/schools/:id/billing-preview.
CREATE OR REPLACE FUNCTION billable_student_count(p_school_id uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT sc.student_id)::integer
    FROM student_classes sc
    JOIN academic_sessions s ON s.id = sc.session_id
   WHERE s.school_id = p_school_id
     AND s.is_current = TRUE
$$;

COMMENT ON FUNCTION billable_student_count(uuid) IS
  'Students with a student_classes row in the school''s current academic session, each counted once. The count platform billing is derived from (migration 045).';

-- Replaces 044's body; the BEFORE INSERT OR UPDATE trigger on platform_subscriptions
-- keeps pointing here. Whatever the caller passed for amount_naira is discarded.
CREATE OR REPLACE FUNCTION compute_subscription_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rate_kobo bigint;
  has_current_session boolean;
  billable integer;
BEGIN
  IF NEW.plan = 'trial' THEN
    NEW.amount_naira := 0.00;
    RETURN NEW;
  END IF;

  SELECT price_per_student_kobo INTO rate_kobo FROM platform_pricing_config LIMIT 1;
  IF rate_kobo IS NULL THEN
    RAISE EXCEPTION 'platform_pricing_config has no rate set; amount_naira cannot be derived'
      USING ERRCODE = 'BL001',
            HINT = 'INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (<rate>) first (migration 044).';
  END IF;

  SELECT EXISTS (SELECT 1 FROM academic_sessions WHERE school_id = NEW.school_id AND is_current = TRUE)
    INTO has_current_session;

  IF NOT has_current_session THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'school % has no current academic session; a paid subscription cannot be priced', NEW.school_id
        USING ERRCODE = 'BL002',
              HINT = 'Set the school''s current academic session first.';
    END IF;
    NEW.amount_naira := OLD.amount_naira;
    RAISE WARNING 'school % has no current academic session; amount_naira left at its last computed value (%)',
      NEW.school_id, OLD.amount_naira;
    RETURN NEW;
  END IF;

  billable := billable_student_count(NEW.school_id);
  NEW.amount_naira := ROUND((billable::numeric * rate_kobo) / 100.0, 2);
  RETURN NEW;
END;
$$;

-- Re-fires the trigger above on a school's subscription row, if it has one. Catches
-- exactly the no-rate case (BL001) and nothing else — see the header.
CREATE OR REPLACE FUNCTION touch_platform_subscription(p_school_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_school_id IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    UPDATE platform_subscriptions SET updated_at = now() WHERE school_id = p_school_id;
  EXCEPTION WHEN SQLSTATE 'BL001' THEN
    RAISE WARNING 'platform_subscriptions not recomputed for school % (no rate configured; the enrolment write proceeds): %',
      p_school_id, SQLERRM;
  END;
END;
$$;

-- Enrolment changes: the school is reached through the session the row belongs to. An
-- UPDATE that moves a row between sessions of two schools touches both.
CREATE OR REPLACE FUNCTION student_classes_recompute_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_school uuid;
  new_school uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT school_id INTO old_school FROM academic_sessions WHERE id = OLD.session_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT school_id INTO new_school FROM academic_sessions WHERE id = NEW.session_id;
  END IF;
  PERFORM touch_platform_subscription(COALESCE(new_school, old_school));
  IF old_school IS NOT NULL AND new_school IS NOT NULL AND old_school <> new_school THEN
    PERFORM touch_platform_subscription(old_school);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS student_classes_recompute_subscription ON student_classes;
CREATE TRIGGER student_classes_recompute_subscription
  AFTER INSERT OR UPDATE OR DELETE ON student_classes
  FOR EACH ROW EXECUTE FUNCTION student_classes_recompute_subscription();

-- Session rollover: whichever session gains or loses is_current changes who counts.
CREATE OR REPLACE FUNCTION academic_sessions_recompute_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(NEW.is_current, FALSE) OR COALESCE(OLD.is_current, FALSE) THEN
    PERFORM touch_platform_subscription(COALESCE(NEW.school_id, OLD.school_id));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS academic_sessions_recompute_subscription ON academic_sessions;
CREATE TRIGGER academic_sessions_recompute_subscription
  AFTER INSERT OR UPDATE OF is_current OR DELETE ON academic_sessions
  FOR EACH ROW EXECUTE FUNCTION academic_sessions_recompute_subscription();

-- 044's trigger on students: replaced by the two above, see the header.
DROP TRIGGER IF EXISTS students_recompute_subscription ON students;
DROP FUNCTION IF EXISTS students_recompute_subscription();

-- The bypass policy 044 left out.
DROP POLICY IF EXISTS service_role_bypass ON platform_pricing_config;
CREATE POLICY service_role_bypass ON platform_pricing_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);
