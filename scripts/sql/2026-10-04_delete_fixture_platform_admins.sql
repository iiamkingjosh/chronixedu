-- One-off, reviewed: delete the three anonymised platform-admin rows that nothing references (4 Oct 2026).
--
-- Revised the same day. It first named nine: these three and six fixture admins. Before it was run,
-- the Remove button was used on those six as well (17:14-17:16 UTC). That anonymised them and recorded
-- each removal, so they now have audit history. The first version's check refused, deleting nothing,
-- which is what the check is for. Those six stay as anonymised rows, like every admin row with history.
--
-- Run by Moses in the Supabase SQL editor; production deletions are his to run (CLAUDE.md). It is one
-- DO block, so it is all or nothing. It refuses, changing nothing, unless all of these hold:
--   - every id is a platform admin, and there are exactly three of them;
--   - neither the root admin (info@chronixtechnology.com) nor the system account is among them;
--   - none has a Supabase Auth login;
--   - none appears in platform_audit_logs, as actor or target.
-- Then it deletes exactly three rows, or none. Any other table still pointing at one of them would make
-- the DELETE fail and roll everything back. Measured before the first version: all 34 foreign keys to
-- users, 0 references to any of these three. Re-measured after the Remove clicks: still none.
--
-- The three: rows already anonymised as deleted-admin-…, inactive, with no login and no audit history.
--
-- Not here, on purpose: the nine anonymised admin rows that have audit history (eight removed with the
-- Remove button on 4 Oct, and e48f826d… earlier). They stay as they are.

DO $$
DECLARE
  ids uuid[] := ARRAY[
    -- already anonymised, no audit history
    'f14544c1-9017-4331-8a63-0a60a84e02ef', 'e2bb8dbe-575e-4453-a0be-130c3e8556f6', '8c30fcc7-11bd-4d85-aa14-fa9a02689cdd'
  ]::uuid[];
  n int;
BEGIN
  IF (SELECT count(*) FROM users WHERE id = ANY (ids) AND role = 'super_admin') <> 3 THEN
    RAISE EXCEPTION 'Expected these 3 ids to be 3 platform admins. Nothing was deleted.';
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
  IF n <> 3 THEN
    RAISE EXCEPTION 'Deleted % rows, not 3, so nothing was deleted.', n;
  END IF;
  RAISE NOTICE 'Deleted the 3 anonymised platform-admin rows.';
END $$;
