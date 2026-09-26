-- 039: a school is always born dormant.
--
-- 038 added a BEFORE UPDATE trigger requiring a principal before activation, and its
-- header called the INSERT exemption a feature: "fixtures that INSERT an active school
-- directly are unaffected". Production disagrees. Of 45 schools, 29 are active with no
-- principal, and every one of them arrived by INSERT — 038 would not have stopped a
-- single one. It guarded the path that produced none of the bad rows and exempted the
-- path that produced all of them.
--
-- That is doctrine 7 failing on the fourth guard of the migration that introduced
-- doctrine 7: the forbidden operations were enumerated for the audit_logs guards and
-- not for this one. The question "which operation actually produced the rows I am
-- trying to prevent?" was never asked.
--
-- `schools.is_active` also still DEFAULTS TO TRUE, which is what made insertSchool
-- wrong in the first place. Passing FALSE explicitly fixed today's caller and left the
-- default armed for the next person who writes INSERT INTO schools without thinking
-- about it.
--
-- The rule, stated so it explains itself: a school is created dormant and activated
-- afterwards, once it has an active principal. Both routes already work this way.
--
--   INSERT with is_active = TRUE  -> rejected outright. It cannot be made conditional
--                                   on having a principal, because users.school_id
--                                   references schools — no user can exist before the
--                                   school does.
--   UPDATE FALSE -> TRUE          -> requires an ACTIVE principal. 038 checked only
--                                   role = 'principal'; superAdmin.ts:2416 deactivates
--                                   users, so a school whose only principal had been
--                                   deactivated still reactivated into the same
--                                   unadministerable state.
--   Everything else               -> untouched: suspension, and any other column
--                                   change on an already-active school.

ALTER TABLE schools ALTER COLUMN is_active SET DEFAULT FALSE;

CREATE OR REPLACE FUNCTION schools_require_principal_on_activate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_active THEN
      RAISE EXCEPTION 'a school cannot be created already active (school %)', NEW.name
        USING HINT = 'Insert the school dormant, create its principal, then activate it — users.school_id references schools, so a principal cannot exist at insert time.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_active AND NOT OLD.is_active THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE school_id = NEW.id AND role = 'principal' AND is_active
    ) THEN
      RAISE EXCEPTION 'school % cannot be activated: it has no active principal', NEW.id
        USING HINT = 'Create or re-enable a principal for this school first — an active school with no active principal is one nobody can administer.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schools_require_principal ON schools;
CREATE TRIGGER schools_require_principal
  BEFORE INSERT OR UPDATE ON schools
  FOR EACH ROW EXECUTE FUNCTION schools_require_principal_on_activate();

-- The 29 existing active principalless schools are left alone. All 29 are is_demo
-- fixtures; the single real customer has an active principal. Deactivating them would
-- be a data change dressed up as a migration, and they are already excluded from every
-- platform count by is_demo.
