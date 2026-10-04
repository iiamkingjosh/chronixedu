-- One-off, reviewed: delete the nine fixture platform admins that nothing references (4 Oct 2026).
--
-- Run by Moses in the Supabase SQL editor; production deletions are his to run (CLAUDE.md). It is one
-- DO block, so it is all or nothing. It refuses, changing nothing, unless all of these hold:
--   - every id is a platform admin, and there are exactly nine of them;
--   - neither the root admin (info@chronixtechnology.com) nor the system account is among them;
--   - none has a Supabase Auth login;
--   - none appears in platform_audit_logs, as actor or target.
-- Then it deletes exactly nine rows, or none. Any other table still pointing at one of them would make
-- the DELETE fail and roll everything back. Measured before writing this: all 34 foreign keys to
-- users, 0 references to any of the nine.
--
-- The nine: six fixture admins created by integration tests in August, and three rows already
-- anonymised as deleted-admin-…, none with any audit history.
--
-- Not here, on purpose:
--   - 104e865f… and 667da186… have platform audit history. They go through the product's Remove
--     button, which anonymises and records in one step.
--   - e48f826d… is already anonymised and has audit history: it stays as it is.

DO $$
DECLARE
  ids uuid[] := ARRAY[
    -- already anonymised, no audit history
    'f14544c1-9017-4331-8a63-0a60a84e02ef', 'e2bb8dbe-575e-4453-a0be-130c3e8556f6', '8c30fcc7-11bd-4d85-aa14-fa9a02689cdd',
    -- fixture admins, no audit history
    'e5750c62-6cc0-4b53-93a6-ba6723daa973', 'e9351fcc-3744-42c6-9e37-2894988da3f0', '13dda6ec-e040-44e6-93b4-8c339cd2398b',
    'd37b8c81-7a51-44b0-8581-57440d171254', '521b57c2-6f8d-47f3-b6f8-77877fcb2a3c', '90dda3a1-b253-4e9c-a2bb-1e7f6a267205'
  ]::uuid[];
  n int;
BEGIN
  IF (SELECT count(*) FROM users WHERE id = ANY (ids) AND role = 'super_admin') <> 9 THEN
    RAISE EXCEPTION 'Expected these 9 ids to be 9 platform admins. Nothing was deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = ANY (ids)
             AND (lower(email) = 'info@chronixtechnology.com' OR id = '00000000-0000-4000-8000-00000000c0de')) THEN
    RAISE EXCEPTION 'The root admin or the system account is in the list. Nothing was deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = ANY (ids)) THEN
    RAISE EXCEPTION 'One of them has a Supabase login; use the Remove button instead. Nothing was deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM platform_audit_logs WHERE platform_admin_id = ANY (ids) OR target_user_id = ANY (ids)) THEN
    RAISE EXCEPTION 'One of them has platform audit history; use the Remove button instead. Nothing was deleted.';
  END IF;

  DELETE FROM users WHERE id = ANY (ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 9 THEN
    RAISE EXCEPTION 'Deleted % rows, not 9, so nothing was deleted.', n;
  END IF;
  RAISE NOTICE 'Deleted the 9 fixture platform admins.';
END $$;
