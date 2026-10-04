# Platform-admin two-factor: keys, recovery and break-glass

Two-factor sign-in for platform admins (`super_admin`) is being built in steps, decided 3 Oct 2026:

1. Recovery and storage (migration 055). Built.
2. Enrolment: the security page, the QR code, and recovery codes shown once (migration 056). Built.
3. The sign-in step: a code after the password, before any token is issued (migration 057). Built.
4. Enforcement (migration 058). Built. Enrolling is optional (decided 3 Oct 2026) for the admins who
   existed before it, required for every platform admin created since, and shown on the platform
   dashboard and the Admins list. For an enrolled admin, a session that has not passed the second
   factor is signed out.
5. Moving to a new phone while the old one still works (migration 059), and the setting that makes
   two-factor required for your own account. Built.

Commits 1 to 5 exist. An admin switches it on at **Administration → Two-factor Sign-in**
(`/super-admin/security`).

## Who must use it

- **An admin added since 4 Oct 2026 must set it up before using anything else.** After their first
  sign-in, every platform page sends them to Two-factor Sign-in, which says it is required. Once it is
  on, the rest opens at once, without signing in again.
- **The admins who existed before 4 Oct 2026 may choose.** The dashboard shows "Two-factor sign-in:
  off" until they switch it on, so the choice stays visible.
- **The Admins list shows each admin's state:** "On", "On, required", "Off", or "Required, not set
  up".

Whether an admin must set it up is recorded when the account is made. Afterwards an admin can make it
required for their own account, and only the root admin can make it optional again. Each change is
recorded with the value it replaced.

## Signed out with "Two-factor sign-in is on for your account"

That message on the sign-in page means the session in use had not passed the second factor. It
appears once, when enforcement goes live, for a session started before it. Sign in again with your
password and a code.

## Switching it on

1. Open Two-factor Sign-in and confirm your password. A wrong password counts against the sign-in
   lockout, the same five tries as signing in.
2. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator,
   1Password), or type the key shown beside it.
3. Enter the 6-digit code. It switches on, every other session on the account is signed out, and ten
   recovery codes appear once. Copy or download them before pressing "I have saved them".

There is no switch to turn it off. New recovery codes can be made with a current code.

## Signing in with it

1. Enter your email and password as usual. Instead of the dashboard, you are asked for a code.
2. Enter the 6-digit code your authenticator app shows now. Keep the page open: the sign-in lives in
   the page, so a refresh sends you back to the password.
3. Lost your phone? Choose "Use a recovery code" and enter one. It works once. You are told how many
   are left and whether the notice email reached you. Make a new set once you have an authenticator
   again.

Wrong codes count against the sign-in lockout. After ten in a row, across sign-ins, two-factor locks
for 15 minutes and Chronix is alerted. A correct password followed by wrong codes means the password
is known, so change it.

## Moving to a new phone

For when your current phone still works. If it is lost, sign in with a recovery code instead.

1. On Two-factor Sign-in, under "Moving to a new phone", enter your password and a code from your
   CURRENT phone.
2. Scan the new QR code with the authenticator app on your NEW phone. Your current phone keeps working
   until you finish. If you stop here, nothing has changed.
3. Within 15 minutes, enter a code from the NEW phone. It switches over:
   - the old phone's codes stop working;
   - every other session on your account is signed out;
   - your recovery codes stay the same.

## Making it required for your account

Under "Optional for your account", choose "Make it required". Before anything changes, the page says
what it means:
- **With two-factor on,** nothing changes day to day. If it is ever reset (break-glass), you will have
  to set it up again before using anything else.
- **Without two-factor on,** you are confined to the Two-factor Sign-in page until you set it up.

Only the root admin can make it optional again. Every change is recorded with the value it replaced,
and the Admins list shows it.

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
