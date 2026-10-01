-- 050: a user's support code is assigned from codes not already in use.
--
-- Migration 025 gave users.support_code (UNIQUE, NOT NULL) a DEFAULT of a random six-digit
-- number and no retry, judging that "collision odds are negligible at this app's scale" and that
-- a collision "would fail that one insert". The second half is true; the first is the birthday
-- problem. Each new user collides with probability (existing users / 900,000), and within one
-- batch of m new users roughly m^2 / 1,800,000 more. With 307 users in production (1 Oct 2026),
-- a 1,600-account bulk onboarding has roughly an 85% chance that at least one insert fails, and
-- the odds rise with every school. It surfaced as a flaky CI failure first: run 189,
-- `duplicate key value violates unique constraint "users_support_code_key"` in the DB suite's
-- shared seed, which inserts a dozen users per test (a few percent per full run).
--
-- Now: no DEFAULT. A BEFORE INSERT trigger fills a NULL support_code with a random six-digit code
-- that no user holds, retrying until it finds one. Six digits stay, because the code is read aloud
-- to a platform admin. A row-level BEFORE trigger sees the rows its own statement inserted
-- earlier, so a multi-row INSERT cannot collide with itself either. An explicit support_code is
-- left as given (the UNIQUE constraint still applies to it). Existing codes are not touched.
--
-- What this does not cover: two transactions committing the same freshly chosen code at the same
-- moment. That needs two concurrent inserts to draw the same unused code out of ~900,000, and the
-- loser fails exactly as before. Not worth a lock.
--
-- Operations checked, one at a time (doctrine 7):
--   INSERT without support_code: the trigger assigns an unused code (tested, including a forced
--     collision with setseed());
--   INSERT with support_code: unchanged, still UNIQUE;
--   UPDATE: no trigger; nothing in the app writes support_code;
--   NOT NULL: still enforced, and checked after BEFORE triggers, so the trigger fills it first.
-- The function is a trigger function: PostgREST cannot call it over /rest/v1/rpc ("trigger functions
-- can only be called as triggers"), so the default EXECUTE grant exposes nothing.

ALTER TABLE users ALTER COLUMN support_code DROP DEFAULT;

CREATE OR REPLACE FUNCTION assign_user_support_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate TEXT;
BEGIN
  IF NEW.support_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := (floor(random() * 900000 + 100000))::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE support_code = candidate);
  END LOOP;
  NEW.support_code := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_assign_support_code ON users;
CREATE TRIGGER users_assign_support_code
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION assign_user_support_code();
