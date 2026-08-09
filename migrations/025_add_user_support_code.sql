-- Adds a short, human-readable support code to each user — read aloud to a
-- platform admin instead of an internal UUID when requesting help. Used to
-- look up the target user when starting a support session.
--
-- Collision odds are negligible at this app's scale (900,000 possible
-- values per digit-length); a new-row collision would fail that one insert
-- rather than corrupt data, so no retry trigger is added for the DEFAULT.

ALTER TABLE users
  ADD COLUMN support_code TEXT UNIQUE
    DEFAULT (floor(random() * 900000 + 100000))::text;

-- Backfill existing rows one at a time with an explicit uniqueness check
-- (a single bulk UPDATE could generate a same-batch collision).
DO $$
DECLARE
  r RECORD;
  new_code TEXT;
BEGIN
  FOR r IN SELECT id FROM users WHERE support_code IS NULL LOOP
    LOOP
      new_code := (floor(random() * 900000 + 100000))::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE support_code = new_code);
    END LOOP;
    UPDATE users SET support_code = new_code WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN support_code SET NOT NULL;
