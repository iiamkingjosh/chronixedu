-- 053: a system account for changes no admin made (2 Oct 2026, SECURITY.md Round 30 L-03).
--
-- The trial gate records each change it makes (grace, read-only, healing a paid plan) in
-- platform_audit_logs, whose platform_admin_id is a NOT NULL foreign key to users. It filled that
-- with SELECT id FROM users WHERE role = 'super_admin' LIMIT 1: no ORDER BY and no is_active, so
-- whichever admin Postgres returned first. Chronix High School's 8 Sep 2026 auto-suspend is
-- recorded as done by a test fixture. That record is left as it is: history is not rewritten.
--
-- This creates the row the gate now signs with, by fixed id (apps/api/src/config/systemActor.ts).
-- It is a super_admin row only so the foreign key holds. It cannot act as one:
--   * no Supabase identity and an empty password_hash: it cannot sign in;
--   * inactive, and the CHECK below keeps it inactive, whatever any route or script does later.
--     Everything that grants a super_admin row anything requires is_active: the last-admin guard
--     (routes/superAdmin.ts countOtherActiveAdmins), the purge function's operator (048) and
--     delete-school-data.js's operator lookup.
--
-- Operations this migration constrains, each checked on its own (doctrine 7):
--   UPDATE users SET is_active = true for this id: refused by the CHECK (tested). No route does
--   it: the reactivate route answers 404 for this id first (tested).
--   UPDATE of any other column, DELETE: not constrained here. The admin routes refuse this id,
--   and nothing else in the code targets it.
--   INSERT/UPDATE of any other user: unaffected, as the CHECK only binds this id (tested with a
--   normal admin reactivated in the same test).

INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
VALUES ('00000000-0000-4000-8000-00000000c0de', NULL, 'system@chronixedu.internal', '', 'super_admin', 'Chronix', 'System', false, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_system_account_never_active;
ALTER TABLE users ADD CONSTRAINT users_system_account_never_active
  CHECK (id <> '00000000-0000-4000-8000-00000000c0de'::uuid OR is_active = false);
