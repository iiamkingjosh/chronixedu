-- 051: the support-code retry loop stops after 100 draws, with a named error.
--
-- 050 replaced 025's random DEFAULT (which failed an insert on a collision, judged "negligible")
-- with a trigger that keeps drawing until it finds an unused code. That loop had no bound: the same
-- judgement one level up, that it always ends quickly at this app's scale. It will at any scale this
-- platform reaches. But if it ever did not, the failure would be a hang inside a transaction, which
-- presents as "the database is slow" and names the wrong thing, where a constraint violation at
-- least names its constraint (the loud failure is the better bug). Raised by the reviewer, 1 Oct 2026.
--
-- The scheme's ceiling, recorded: six digits hold at most 900,000 accounts platform-wide. With a
-- fraction f of codes in use, expected draws are 1/(1-f), and 100 draws all hitting taken codes has
-- probability f^100: about 1e-30 at half full, 3e-5 at 90%, 0.6% at 95%. So the bound fires only as
-- the space runs out, and then it says so: SQLSTATE SC001 with the count in use. The API surfaces it
-- as an unhandled error, which reaches Sentry. When it does, widen the code, do not raise the bound.
--
-- Operations checked (doctrine 7): INSERT without a code, at most 100 draws then SC001 (tested by
-- taking the trigger's next 100 draws with setseed(), and with only 99 taken, the 100th succeeds);
-- INSERT with a code, unchanged; UPDATE, no trigger.

CREATE OR REPLACE FUNCTION assign_user_support_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate TEXT;
  draws INT := 0;
BEGIN
  IF NEW.support_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    IF draws >= 100 THEN
      RAISE EXCEPTION 'users.support_code: no unused six-digit code in 100 random draws (% of the 900,000 codes are in use)',
        (SELECT count(*) FROM users)
        USING ERRCODE = 'SC001',
              HINT = 'The six-digit support-code space is nearly full: widen the code (migration 051 header).';
    END IF;
    draws := draws + 1;
    candidate := (floor(random() * 900000 + 100000))::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE support_code = candidate);
  END LOOP;
  NEW.support_code := candidate;
  RETURN NEW;
END;
$$;
