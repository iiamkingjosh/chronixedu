# Platform-admin two-factor: keys, recovery and break-glass

Two-factor sign-in for platform admins (`super_admin`) is being built in steps, decided 3 Oct 2026:

1. Recovery and storage (migration 055). Built.
2. Enrolment: the security page, the QR code, and recovery codes shown once (migration 056). Built.
3. The sign-in step: a code after the password, before any token is issued.
4. Enforcement, for admins who have enrolled. Enrolling is optional (decided 3 Oct 2026) for existing
   admins, required for any platform admin created from now on, and shown on the platform
   dashboard. For an enrolled admin, every session that has not passed the second factor will be
   signed out, including the one in use.
5. Moving to a new phone while the old one still works. Until then, the only way is break-glass.

Commits 1 and 2 exist: an admin can switch it on at **Administration → Two-factor Sign-in**
(`/super-admin/security`). Until commit 4 is live, nobody is required to use it, and it is not asked
for at sign-in until commit 3.

## Switching it on

1. Open Two-factor Sign-in and confirm your password. A wrong password counts against the sign-in
   lockout, the same five tries as signing in.
2. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator,
   1Password), or type the key shown beside it.
3. Enter the 6-digit code. It switches on, every other session on the account is signed out, and ten
   recovery codes appear once. Copy or download them before pressing "I have saved them".

There is no switch to turn it off. New recovery codes can be made with a current code.

## The encryption key: `TOTP_ENCRYPTION_KEY`

Each admin's authenticator secret is stored encrypted under this key (`services/totpSecretBox.ts`).
The API refuses to start without it.

- **Make it once:** `openssl rand -base64 32`, run on your own machine. Never paste it into a chat or
  a ticket, and never into this repository.
- **Store it twice:** in Railway (API service → Variables) and in the password manager. Railway alone
  is not a backup.
- **If it is lost:** every enrolled admin's secret becomes unreadable. Nobody can sign in with a code.
  Set a new key, then run break-glass for each enrolled admin, and each enrols again.
- **Never change it casually.** A new value has the same effect as losing the old one, for everyone at
  once. Rotation without that effect needs code that does not exist yet (the stored format carries a
  version byte for it).

## Recovery codes

At enrolment each admin gets ten one-time codes, shown once. Each replaces an authenticator code at
sign-in, once. Keep them somewhere other than the phone, such as the password manager or on paper. The
database holds only their hashes, so nobody can read them back, including Chronix.

## Break-glass: phone and recovery codes both lost

Production has one platform admin who can sign in. If that admin loses both, there is no second admin
to reset them. This is the way back. It switches off that admin's second factor, so they can sign in
with their password and enrol again.

**Who runs it:** someone signed in to the Supabase dashboard for the `pgnpmqaowrnmsytpehwc` project.
That account is therefore the real key to the platform, above this feature. Turn on two-factor for
Supabase, Railway, GitHub and Sentry.

1. **Be sure who is asking.** If it is not you, confirm it is the admin by a channel you already trust,
   such as a known phone number. Never trust an email asking for it.
2. **Find the admin's id.** In the SQL editor:
   ```sql
   SELECT id, email, is_active FROM users WHERE role = 'super_admin' AND email = '<their address>';
   ```
3. **Reset, with the reason.**
   ```sql
   SELECT chronixedu_two_factor.break_glass_reset('<id>', '<why, and how identity was confirmed>');
   ```
   It answers with the number of recovery codes removed. It refuses with a plain message for:
   - a missing reason;
   - someone who is not a platform admin;
   - an admin with no two-factor to reset.
4. **Check the record.**
   ```sql
   SELECT created_at, metadata FROM platform_audit_logs
    WHERE action_type = 'TWO_FACTOR_REMOVED' ORDER BY created_at DESC LIMIT 1;
   ```
   `metadata` names the admin, `by: break_glass_reset`, your reason, and the database role that ran it.
   It is signed by the system account, because no admin was signed in to do it.
5. **The admin signs in with their password and enrols again at once.** Until they do, their account
   is protected by the password alone.

**What not to do:**
- **Do not `DELETE FROM user_totp` by hand.** It works, and it is still recorded, as
  `by: a DELETE on user_totp`. But it carries no reason, and it leaves the old recovery codes in place.
- **Never grant EXECUTE on `chronixedu_two_factor.break_glass_reset` to anyone.** Supabase serves
  callable functions to the public over `/rest/v1/rpc`, and this one switches off a second factor.

## What is recorded, and where

Every removal of an ACTIVE second factor writes a `TWO_FACTOR_REMOVED` row to `platform_audit_logs`,
whatever removed it: this function, a plain DELETE, or deleting the admin's user row. The record keeps
the admin's id in `metadata` (`target_user_id` is NULL), so it survives the user being deleted. An
enrolment that was started but never switched on is not recorded when removed, because no protection
was in force. The secret and the recovery codes never appear in any record, log or Sentry event.
