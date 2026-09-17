-- Migration 031: enable RLS on the nine tables that never had it.
--
-- AUDIT C-3. payments, fee_invoices, fee_structures, report_cards,
-- email_queue, class_teacher_comments, principal_remarks, timetable_slots and
-- school_analytics_snapshots had RLS disabled. The Supabase publishable key is
-- shipped to the browser, so with Supabase's default grants these were
-- reachable through /rest/v1 by anyone.
--
-- The Express API connects as the table owner (bypasses RLS), so this does not
-- change API behaviour. No browser code reads these tables directly, so anon
-- access is revoked outright.

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payments', 'fee_invoices', 'fee_structures', 'report_cards', 'email_queue',
    'class_teacher_comments', 'principal_remarks', 'timetable_slots',
    'school_analytics_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('DROP POLICY IF EXISTS service_role_bypass ON %I', t);
    EXECUTE format('CREATE POLICY service_role_bypass ON %I FOR ALL TO service_role USING (true)', t);
  END LOOP;

  -- Tenant-scoped tables that carry school_id directly.
  FOREACH t IN ARRAY ARRAY[
    'payments', 'fee_invoices', 'fee_structures', 'report_cards',
    'timetable_slots', 'school_analytics_snapshots'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (school_id = (auth.jwt() ->> %L)::uuid) WITH CHECK (school_id = (auth.jwt() ->> %L)::uuid)',
      t || '_tenant', t, 'school_id', 'school_id');
  END LOOP;
END $$;

-- Tables scoped through the student.
DROP POLICY IF EXISTS class_teacher_comments_tenant ON class_teacher_comments;
CREATE POLICY class_teacher_comments_tenant ON class_teacher_comments
  FOR ALL USING (EXISTS (
    SELECT 1 FROM students s
    WHERE s.id = class_teacher_comments.student_id
      AND s.school_id = (auth.jwt() ->> 'school_id')::uuid));

DROP POLICY IF EXISTS principal_remarks_tenant ON principal_remarks;
CREATE POLICY principal_remarks_tenant ON principal_remarks
  FOR ALL USING (EXISTS (
    SELECT 1 FROM students s
    WHERE s.id = principal_remarks.student_id
      AND s.school_id = (auth.jwt() ->> 'school_id')::uuid));

-- email_queue is platform-internal: no tenant policy, so only service_role
-- (and the owner-connected API) can touch it.

COMMIT;
