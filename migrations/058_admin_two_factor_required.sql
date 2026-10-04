-- 058: platform-admin two-factor, commit 4 of 4: who must have it (4 Oct 2026).
--
-- Enrolling is optional for the platform admins who exist today (Moses, 3 Oct 2026), and required
-- for every platform admin created from now on, so the choice stays his for his own account and is
-- not inherited by accounts he adds. Whether it is required is a fact stated when the account is
-- made, never inferred, from a date or from a default (doctrine 8): this column has no default.
--
--   users.two_factor_required  true: must enrol before reaching anything but the 2FA setup routes.
--                              false: may enrol, or not (decided, for each admin who exists today).
--                              NULL: not a platform admin; two-factor does not apply.
--
-- A CHECK constraint, not a trigger (reviewer, 4 Oct 2026). Doctrine 6 records that DISABLE TRIGGER
-- ALL is not blocked, so a trigger-enforced rule can be switched off by anyone who can run DDL; a
-- CHECK holds regardless, and states the rule where someone reading the schema sees it. Same shape as
-- migration 053's users_system_account_never_active.
--
-- Operations, each checked on its own (doctrine 7):
--   INSERT of a super_admin without two_factor_required: refused (tested). Every creation path
--     states it: POST /super-admin/admins and the bootstrap script say true; /auth/create-user and
--     the dev seed say true for a super_admin and NULL otherwise.
--   INSERT of anyone else without it: allowed, NULL (tested, as the control).
--   UPDATE that makes someone a super_admin without stating it: refused, same constraint.
--   UPDATE of two_factor_required on an existing admin: allowed; nothing in the app does it.
--
-- The backfill below is the decision for today's admins, the system account among them (it can
-- never sign in, so it can never enrol; false is the only true statement about it).

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_required boolean;

UPDATE users SET two_factor_required = false
 WHERE role = 'super_admin' AND two_factor_required IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_admin_states_two_factor') THEN
    ALTER TABLE users ADD CONSTRAINT users_admin_states_two_factor
      CHECK (role <> 'super_admin' OR two_factor_required IS NOT NULL);
  END IF;
END $$;

-- End of migration 058
