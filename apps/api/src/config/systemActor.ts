/**
 * The account automated jobs sign platform audit rows with (migration 053, 2 Oct 2026).
 *
 * `platform_audit_logs.platform_admin_id` is a NOT NULL foreign key to `users`, so a change the
 * system makes on its own still needs a row to name. The trial gate used to take
 * `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`: whichever admin Postgres returned
 * first, fixtures and deactivated accounts included. Chronix High School's 8 Sep 2026 suspension is
 * recorded as done by a test fixture that way (SECURITY.md Round 30, L-03). No admin did it.
 *
 * The account is a `super_admin` row so the foreign key holds. It can never act as one:
 * - it has no Supabase identity and an empty password hash, and login looks the local row up by
 *   the Supabase user's id, so it cannot sign in;
 * - it is inactive, and migration 053's CHECK (`users_system_account_never_active`) keeps it so;
 *   every query that grants anything to a super_admin row (the last-admin guard, the purge
 *   function's operator, the deletion script's operator) requires `is_active`;
 * - the admin routes list it as a system account and refuse to act on it.
 *
 * Migration 053 writes these values; `systemActor.test.ts` checks the migration still matches.
 */
export const SYSTEM_ACTOR = {
  id: '00000000-0000-4000-8000-00000000c0de',
  email: 'system@chronixedu.internal',
  firstName: 'Chronix',
  lastName: 'System',
} as const;

export const SYSTEM_ACTOR_ID = SYSTEM_ACTOR.id;

export function isSystemActor(id: string | null | undefined): boolean {
  return id === SYSTEM_ACTOR_ID;
}
