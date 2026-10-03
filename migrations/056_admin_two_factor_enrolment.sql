-- 056: platform-admin two-factor, commit 2 of 4: enrolment (3 Oct 2026).
--
-- user_totp gains what a working second factor needs:
--   last_used_step   the TOTP time step last accepted. A code at or before it is refused, so a code
--                    seen over someone's shoulder cannot be used again (replay). Set at enrolment,
--                    because the confirming code is a code like any other.
--   failed_attempts  wrong codes in a row, held in the database, not Redis. Redis fails open on
--   locked_until     the request path (SECURITY.md Round 19), and with it down a six-digit factor
--                    would be an unlimited guessing oracle (decision c). Ten in a row lock the
--                    factor for fifteen minutes, per account; the first lock alerts.
--
-- users gains sessions_valid_after: a token issued before it is refused (verifyToken). Enrolling
-- sets it, ending every other session the admin had, so a session stolen before enrolment does not
-- outlive it; the admin's own session is given a fresh token in the same response. Only platform
-- admins' tokens are checked against it today, because only they can enrol (verifyToken says so).
--
-- No new table, so the export and deletion ratchets and the RLS inventory are unchanged.
-- failed_attempts defaults to 0: a count that has not started is zero, not unknown.

ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS last_used_step bigint;
ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;

-- End of migration 056
