-- 060: a password cannot be reused within 60 days (Moses, 5 Oct 2026).
--
-- password_history keeps the bcrypt hash of each password an account REPLACED, and when. A new
-- password is refused when it matches the account's current hash or any row replaced within the
-- last 60 days (services/passwordReuse.ts, PASSWORD_REUSE_DAYS). "Two months" was confirmed as 60
-- days, counted from when a password stopped being used, not from when it was set.
--
-- Only what the rule needs is kept. Rows older than the window are deleted on every password change
-- and by the daily password-history-retention job (03:20 Lagos). An old password is still a
-- credential: people reuse passwords on other sites.
--
-- A credential, not school data: RLS on, the service-role bypass only, and every grant revoked from
-- anon and authenticated, as 055 does for the two-factor tables. Never exported (schoolExport.ts
-- NOT_EXPORTED); deleted with the school (delete-school-data.js) and with the user (CASCADE).
--
-- Operations, each on its own (doctrine 7):
--   INSERT: the API, in the transaction that changes the password (changeOwnPassword), and only a
--           bcrypt hash (CHECK): an account created with no password ('') leaves nothing behind.
--   SELECT: the API, to compare a new password with the window.
--   DELETE: the API (past the window: on each change, and daily), the users cascade, and the
--           deletion script.
--   UPDATE: nothing updates a row. Not enforced: this is a credential store, not an audit trail.
--   anon / authenticated: every privilege revoked (tested).

CREATE TABLE IF NOT EXISTS password_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$'),
  retired_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_history_user_retired ON password_history (user_id, retired_at);

ALTER TABLE password_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON password_history;
CREATE POLICY service_role_bypass ON password_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON password_history FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- End of migration 060
