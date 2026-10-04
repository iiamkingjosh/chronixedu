-- 059: platform-admin two-factor, commit 5: moving to a new phone while the old one works (4 Oct 2026).
--
-- The new phone's secret waits in its own columns until a code from the new phone confirms it. Until
-- then the active secret is untouched, so the old phone keeps working, and walking away changes
-- nothing. The confirming step copies the pending secret over the active one in one transaction
-- (db/queries/twoFactorStore.ts completeDeviceMove).
--
--   user_totp.pending_secret_ciphertext  the new phone's secret, encrypted exactly as the active one
--                                        (services/totpSecretBox.ts, bound to the admin's user id).
--   user_totp.pending_created_at         when the move started; it expires after 15 minutes.
--
-- Operations, each checked on its own (doctrine 7):
--   A pending secret beside a factor that is not active: refused by CHECK. A move replaces a WORKING
--     phone; a factor not yet switched on is still enrolment, which has its own path.
--   One of the two columns without the other: refused by CHECK.
--   UPDATE of the active secret_ciphertext: allowed, as before. It writes no TWO_FACTOR_REMOVED row:
--     migration 055's trigger fires on DELETE only, and a move is not a removal. The move writes its
--     own audit row, TWO_FACTOR_DEVICE_MOVED, in the same transaction.
--
-- No grant changes. The login role (docs/c4a/grants.sql) reads user_totp column by column, so the new
-- columns are invisible to it: the unauthenticated sign-in step never sees a pending secret.

ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS pending_secret_ciphertext bytea;
ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS pending_created_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_totp_pending_needs_active') THEN
    ALTER TABLE user_totp ADD CONSTRAINT user_totp_pending_needs_active
      CHECK (pending_secret_ciphertext IS NULL OR activated_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_totp_pending_whole') THEN
    ALTER TABLE user_totp ADD CONSTRAINT user_totp_pending_whole
      CHECK ((pending_secret_ciphertext IS NULL) = (pending_created_at IS NULL));
  END IF;
END $$;

-- End of migration 059
