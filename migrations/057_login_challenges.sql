-- 057: platform-admin two-factor, commit 3 of 4: the second step at sign-in (3 Oct 2026).
--
-- After a correct password, an admin who has switched two-factor on gets no token. They get a
-- challenge: 256 random bits, handed to the browser once and stored here only as a SHA-256 hash, so
-- a read of this table cannot be replayed. It is not a JWT, so verifyToken can never accept it. It
-- dies after CHALLENGE_TTL (five minutes), after one successful code, or after five wrong ones
-- (attempts); consumed_at marks the first two, attempts the third.
--
-- The limit that matters is NOT here. A challenge's five attempts would reset on every new
-- challenge, and anyone with the password can ask for another, so the consecutive-failure counter
-- that locks the factor is per account (user_totp.failed_attempts, migration 056), survives new
-- challenges, and only a right code clears it (reviewer, 3 Oct 2026).
--
-- Retention: a challenge lives minutes. Each new challenge first deletes the same admin's dead ones
-- (expired or consumed), so the table holds at most a few rows per admin with no job to run.
--
-- Not school data and not an export or deletion step: classified in NOT_EXPORTED and NOT_DELETED with
-- reasons, and removed with its user by ON DELETE CASCADE. RLS on, the service-role bypass only, and
-- every grant revoked from anon and authenticated, as for 055's tables.
--
-- Operations, each checked on its own (doctrine 7):
--   anon / authenticated: every privilege revoked (tested).
--   chronixedu_login (C-4a, docs/c4a/grants.sql): SELECT, INSERT, DELETE, UPDATE (consumed_at, attempts).

CREATE TABLE IF NOT EXISTS login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_hash text NOT NULL UNIQUE CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  ip_address text
);
CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges(user_id);

ALTER TABLE login_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_bypass ON login_challenges;
CREATE POLICY service_role_bypass ON login_challenges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON login_challenges FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- End of migration 057
