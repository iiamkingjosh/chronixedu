-- 055: storage and recovery for platform-admin two-factor sign-in (3 Oct 2026).
--
-- The first of four commits (decided 3 Oct 2026): recovery and storage, then enrolment, then the
-- sign-in step, then enforcement. Recovery comes first because production has exactly one platform
-- admin who can sign in. If he enrols and loses his phone there is no second admin to reset him,
-- so the way back is built and tested before anyone can enrol.
--
-- user_totp: one row per admin with an authenticator. secret_ciphertext is AES-256-GCM under
--   TOTP_ENCRYPTION_KEY, bound to the user id (services/totpSecretBox.ts); the database never
--   sees the secret. activated_at NULL means enrolment started and not finished.
-- user_recovery_codes: SHA-256 hashes of one-time codes (services/recoveryCodes.ts); used_at set
--   once, atomically, when one is spent.
--
-- Both are credentials, not school data: RLS on, the service-role bypass only, and every grant
-- revoked from anon and authenticated, so Supabase's REST endpoint serves nothing from them. The
-- API reaches them as the table owner, like every other table (doctrine 2).
--
-- REMOVAL IS RECORDED, WHOEVER DOES IT. Deleting an ACTIVE user_totp row writes a
-- platform_audit_logs row (TWO_FACTOR_REMOVED), signed by the system account (053), with the
-- admin's id, when it had been switched on, the reason if one was given, and the database role.
-- That covers the break-glass function below, a plain DELETE typed into the SQL editor, and the
-- cascade when an admin's user row is deleted. The admin's id goes in metadata, with
-- target_user_id NULL, so the record never blocks deleting that user and outlives them (048's
-- pattern). A pending row's removal is not recorded: no protection was in force.
--
-- BREAK-GLASS: chronixedu_two_factor.break_glass_reset(user_id, reason), for an admin who has lost
-- both phone and recovery codes. Run by Moses in the Supabase SQL editor, as the table owner; see
-- docs/admin-two-factor-runbook.md. It needs no privilege the owner lacks. It exists so that the
-- documented path checks its target and states a reason. Its schema and function are revoked from
-- PUBLIC, anon, authenticated and service_role: Supabase serves EXECUTE-able functions over
-- /rest/v1/rpc, and this one switches off an admin's second factor.
--
-- Operations, each checked on its own (doctrine 7):
--   user_totp / user_recovery_codes, anon and authenticated: every privilege revoked (tested).
--   user_totp DELETE of an active row: recorded (tested: function, plain DELETE, user cascade).
--   user_totp DELETE of a pending row: not recorded (tested, beside an active one that is).
--   user_totp UPDATE: not recorded here. A hand edit of a secret is tampering, which audit
--     enforcement does not stop (doctrine 6); the API records its own changes.
--   break_glass_reset EXECUTE: the owner only (tested with has_function_privilege for each role).

CREATE TABLE IF NOT EXISTS user_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);

ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_recovery_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_bypass ON user_totp;
CREATE POLICY service_role_bypass ON user_totp
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_bypass ON user_recovery_codes;
CREATE POLICY service_role_bypass ON user_recovery_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON user_totp, user_recovery_codes FROM %I', r);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION user_totp_record_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_reason text := nullif(current_setting('chronixedu.two_factor_reset_reason', true), '');
BEGIN
  INSERT INTO public.platform_audit_logs (platform_admin_id, action_type, target_school_id, target_user_id, metadata, ip_address)
  VALUES (
    '00000000-0000-4000-8000-00000000c0de', 'TWO_FACTOR_REMOVED', NULL, NULL,
    jsonb_build_object(
      'user_id', OLD.user_id,
      'activated_at', OLD.activated_at,
      'by', CASE WHEN v_reason IS NULL THEN 'a DELETE on user_totp' ELSE 'break_glass_reset' END,
      'reason', v_reason,
      'database_role', session_user
    ),
    NULL
  );
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION user_totp_record_removal() FROM PUBLIC;

DROP TRIGGER IF EXISTS user_totp_record_removal ON user_totp;
CREATE TRIGGER user_totp_record_removal
  AFTER DELETE ON user_totp
  FOR EACH ROW
  WHEN (OLD.activated_at IS NOT NULL)
  EXECUTE FUNCTION user_totp_record_removal();

CREATE SCHEMA IF NOT EXISTS chronixedu_two_factor;
REVOKE ALL ON SCHEMA chronixedu_two_factor FROM PUBLIC;

CREATE OR REPLACE FUNCTION chronixedu_two_factor.break_glass_reset(p_user_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_codes integer;
BEGIN
  IF p_user_id IS NULL OR coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'break_glass_reset: an admin''s user id and a reason are both required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND role = 'super_admin') THEN
    RAISE EXCEPTION 'break_glass_reset: % is not a platform admin', p_user_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_totp WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'break_glass_reset: % has no two-factor to reset', p_user_id;
  END IF;

  -- Read by the removal trigger, for this transaction only.
  PERFORM set_config('chronixedu.two_factor_reset_reason', btrim(p_reason), true);
  DELETE FROM public.user_recovery_codes WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_codes = ROW_COUNT;
  DELETE FROM public.user_totp WHERE user_id = p_user_id;
  PERFORM set_config('chronixedu.two_factor_reset_reason', '', true);
  RETURN v_codes;
END;
$$;

DO $$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION chronixedu_two_factor.break_glass_reset(uuid, text) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION chronixedu_two_factor.break_glass_reset(uuid, text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA chronixedu_two_factor FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- End of migration 055
