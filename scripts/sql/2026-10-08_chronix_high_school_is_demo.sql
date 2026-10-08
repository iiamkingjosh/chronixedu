-- One-off, reviewed: count Chronix High School as a customer for the ERP revenue pull test, or put it back
-- (8 Oct 2026, Moses).
--
-- Why: the pull (GET /api/partner/revenue, total_mrr_kobo) counts only schools with is_demo = false. Chronix High
-- School is Moses's own pilot, created as demo; he asked for it to count as an actual school so the pull is tested
-- against it. With its ₦1,600 termly subscription active, it adds 160000 kobo / 4 = 40000 kobo to total_mrr_kobo.
-- is_demo changes nothing for the school itself: it is read only by the platform totals, the platform school
-- list and the revenue figure (checked 8 Oct 2026).
--
-- Nothing in the product changes is_demo after creation, by design (CLAUDE.md, "Demo vs customer tenants": a
-- tenant is classified by explicit id, never by a rule). So this names the one school by id and records the change,
-- with the value it replaced, in platform_audit_logs: who (the root admin), what, and why. A direct INSERT, because
-- this runs in the SQL editor and not the API; the same columns logPlatformAudit writes.
--
-- Run by Moses in the Supabase SQL editor. Set to_demo below:
--   false  -> count it as a customer (the test);
--   true   -> put it back as demo. Do this before the first real school pays, or the first real MRR figure
--             includes the pilot (docs/AUDIT-2026-09.md).
-- It is one DO block, all or nothing, and refuses, changing nothing, unless:
--   - the id is Chronix High School;
--   - the school is not already what to_demo asks for;
--   - the root admin is an active platform admin (the audit row's author).

DO $$
DECLARE
  school uuid := 'f1347b5c-584f-43e5-ba05-6770139c6c8f';  -- Chronix High School
  to_demo boolean := false;                                 -- false: count as a customer; true: put back
  reason text := 'Moses, 8 Oct 2026: count the pilot as an actual school for the ERP revenue pull test';
  admin uuid;
  was boolean;
  school_name text;
BEGIN
  SELECT name, is_demo INTO school_name, was FROM schools WHERE id = school FOR UPDATE;
  IF school_name IS NULL OR lower(trim(school_name)) <> 'chronix high school' THEN
    RAISE EXCEPTION 'That id is not Chronix High School (found: %). Nothing was changed.', coalesce(school_name, 'no school');
  END IF;
  IF was = to_demo THEN
    RAISE EXCEPTION 'Chronix High School already has is_demo = %. Nothing was changed.', was;
  END IF;
  SELECT id INTO admin FROM users
   WHERE lower(email) = 'info@chronixtechnology.com' AND role = 'super_admin' AND is_active = true;
  IF admin IS NULL THEN
    RAISE EXCEPTION 'The root admin is not an active platform admin, so the change could not be signed. Nothing was changed.';
  END IF;

  UPDATE schools SET is_demo = to_demo WHERE id = school;
  INSERT INTO platform_audit_logs (platform_admin_id, action_type, target_school_id, metadata, ip_address)
  VALUES (admin, 'SCHOOL_DEMO_FLAG_SET', school,
          jsonb_build_object('is_demo', to_demo, 'previous_is_demo', was, 'reason', reason,
                             'script', 'scripts/sql/2026-10-08_chronix_high_school_is_demo.sql'),
          NULL);
  RAISE NOTICE 'Chronix High School: is_demo % -> %, recorded as SCHOOL_DEMO_FLAG_SET.', was, to_demo;
END $$;
