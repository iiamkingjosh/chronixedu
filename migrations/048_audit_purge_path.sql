-- 048: one school's audit rows can be deleted, through one named function and nothing else.
--
-- DECISION (Moses, 1 Oct 2026): option (a) of docs/data-deletion-runbook.md — delete, via a named
-- purge path. DPA §11 / Terms §22 promise permanent deletion of a school's data within 90 days of
-- termination; audit_logs (append-only since 036/037) held that promise up.
--   * (b), anonymise, was legal on the adviser's reading but not better. It meant scrubbing two
--     arbitrary-shape JSONB columns: measured in production 1 Oct 2026, 269 rows, 20 action_type
--     values, 50 distinct payload keys, against 38 actionType literals the code can emit — 18
--     shapes scrubbed blind, and a missed key is personal data we told a school we had deleted.
--   * (a) is verifiable by count(*) = 0. That is the whole argument.
-- 036's and 037's own HINTs anticipated this: "If a retention or erasure policy genuinely
-- requires this, drop trigger ... in its own migration so the decision is recorded." This is
-- that migration, except that it narrows the trigger instead of dropping it.
--
-- MECHANISM. A NOLOGIN role, chronixedu_audit_purger, with no members, owns a SECURITY DEFINER
-- function, chronixedu_purge.purge_school_audit_logs(school_id, operator_id). Inside that
-- function current_user IS the purger role; nowhere else is it. audit_logs_forbid_delete()
-- lets a DELETE through only when current_user = 'chronixedu_audit_purger'. There is no
-- session flag: a custom GUC can be set by any caller, which would turn the invariant into a
-- convention (CLAUDE.md, Conventions). To DELETE outside the function a role must be GRANTED
-- membership in the purger role (or be a superuser, which production's postgres is not) — a
-- deliberate act that leaves a row in pg_auth_members, which schoolDeletion.db.test.ts asserts
-- is empty of SET/INHERIT grants. Doctrine 6 still holds: this is accident-proofing; the owner
-- can still DISABLE TRIGGER, as before.
--
-- WHY A SEPARATE SCHEMA. Functions created in public get EXECUTE for PUBLIC by default, and
-- Supabase exposes public functions over /rest/v1/rpc to anon. chronixedu_purge is not an
-- exposed schema, PUBLIC has no USAGE on it, and EXECUTE is revoked from PUBLIC, anon,
-- authenticated and service_role — three independent walls, each tested.
--
-- WHAT THE FUNCTION DELETES: audit_logs rows WHERE school_id = the school OR user_id is one of
-- the school's users. The second clause is required, not generous: those users are deleted
-- next, and audit_logs.user_id references users. Nothing else: no "all", no date range.
--
-- THE RECORD OF THE PURGE. Written to platform_audit_logs BEFORE the delete, as
-- SCHOOL_AUDIT_PURGED, platform_admin_id = the operator (NOT NULL; must be an active super_admin
-- outside the school), with target_school_id NULL and the school id inside metadata. That is
-- deliberate: target_school_id is a foreign key to schools, so a record pointing at the school
-- would either block the school's deletion or have to be deleted with it — the loop the spec
-- asked about. Holding the id only in metadata, the record has no FK to break and is not matched
-- by the script's platform_audit_logs purge, so it SURVIVES the deletion permanently. It holds a
-- UUID and two counts — no personal data. The purge of platform_audit_logs itself (the school's
-- other rows) is a plain DELETE in the script: that table has no guard (below).
--
-- ENUMERATION (doctrine 7) — every operation on the two audit tables, before and after 048:
--   audit_logs INSERT ............ unchanged. 048 touches no INSERT trigger or grant.
--   audit_logs DELETE, any role .. still refused (audit_logs_no_delete, statement level).
--   audit_logs DELETE, purger .... allowed — reachable only by executing the function.
--   audit_logs content UPDATE .... still refused. 048 does not touch audit_logs_no_content_change
--                                  or audit_logs_forbid_content_change(), and grants the purger no
--                                  UPDATE. Check: grep -n "content_change\|GRANT UPDATE" on this
--                                  file finds only these comment lines.
--   audit_logs processed_at ...... still write-once: same function, same check, untouched.
--   audit_logs TRUNCATE .......... unchanged: never blocked (doctrine 6, migration 038 header).
--   platform_audit_logs, all ..... unchanged: measured 1 Oct 2026, it has NO triggers at all, so
--                                  DELETE already works for the owner. What kept a school alive
--                                  there was only its foreign keys (platform_admin_id,
--                                  target_school_id, target_user_id — all NO ACTION). Half the
--                                  problem never existed; nothing in 048 is for this table except
--                                  the purger's INSERT grant for the record above.
-- Tested one at a time in schoolDeletion.db.test.ts.
--
-- GRANTS. EXECUTE goes to the role running this migration (the table owner — the only role the
-- script connects as, and one that could already DISABLE TRIGGER). Nothing else.

-- The role. Cluster-wide, so it may already exist in a local test cluster.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chronixedu_audit_purger') THEN
    CREATE ROLE chronixedu_audit_purger NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;
ALTER ROLE chronixedu_audit_purger NOLOGIN NOINHERIT BYPASSRLS;

-- Exactly what the function needs. BYPASSRLS because audit_logs has RLS enabled and the purger
-- is not its owner; without it the DELETE would see no rows and delete nothing, silently.
GRANT USAGE ON SCHEMA public TO chronixedu_audit_purger;
GRANT SELECT, DELETE ON public.audit_logs TO chronixedu_audit_purger;
GRANT SELECT ON public.users, public.schools TO chronixedu_audit_purger;
GRANT INSERT ON public.platform_audit_logs TO chronixedu_audit_purger;

-- The trigger: same message for everyone else, and a HINT that names the one way through.
CREATE OR REPLACE FUNCTION public.audit_logs_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'chronixedu_audit_purger' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (CLAUDE.md doctrine 6): DELETE is not permitted'
    USING HINT = 'One school''s audit rows can be removed only by chronixedu_purge.purge_school_audit_logs(school_id, operator_id) — migration 048, docs/data-deletion-runbook.md.';
END;
$$;

CREATE SCHEMA IF NOT EXISTS chronixedu_purge;
REVOKE ALL ON SCHEMA chronixedu_purge FROM PUBLIC;

CREATE OR REPLACE FUNCTION chronixedu_purge.purge_school_audit_logs(p_school_id uuid, p_operator_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_expected integer;
  v_deleted integer;
BEGIN
  IF p_school_id IS NULL OR p_operator_id IS NULL THEN
    RAISE EXCEPTION 'purge_school_audit_logs: a school id and an operator id are both required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = p_school_id) THEN
    RAISE EXCEPTION 'purge_school_audit_logs: no school %', p_school_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = p_operator_id AND role = 'super_admin' AND is_active
       AND school_id IS DISTINCT FROM p_school_id
  ) THEN
    RAISE EXCEPTION 'purge_school_audit_logs: operator % is not an active Chronix super admin outside this school', p_operator_id;
  END IF;

  SELECT count(*) INTO v_expected FROM public.audit_logs
   WHERE school_id = p_school_id
      OR user_id IN (SELECT id FROM public.users WHERE school_id = p_school_id);

  INSERT INTO public.platform_audit_logs (platform_admin_id, action_type, target_school_id, target_user_id, metadata)
  VALUES (p_operator_id, 'SCHOOL_AUDIT_PURGED', NULL, NULL,
          jsonb_build_object('school_id', p_school_id, 'audit_logs_deleted', v_expected, 'by', 'migration 048 purge path'));

  DELETE FROM public.audit_logs
   WHERE school_id = p_school_id
      OR user_id IN (SELECT id FROM public.users WHERE school_id = p_school_id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- The record says a number; make it the true one or undo everything.
  IF v_deleted <> v_expected THEN
    RAISE EXCEPTION 'purge_school_audit_logs: counted % rows, deleted % — rows changed during the purge; nothing was deleted', v_expected, v_deleted;
  END IF;
  RETURN v_deleted;
END;
$$;

-- Ownership moves to the purger, and the function's grants are then set AS the purger (only an
-- owner can grant on a function, and an ACL set before the move would be rewritten by it: the
-- old owner's entries become the new owner's, so the table owner would silently lose EXECUTE).
-- That needs SET membership in the purger, and USAGE + CREATE for it on the schema (USAGE to
-- resolve the function's name while acting as it; CREATE for the owner change), all granted here
-- for these statements and taken back at the end, so neither survives the migration.
--
-- Who may call it afterwards: the role running this migration (the table owner), nobody else.
-- PUBLIC, anon, authenticated and service_role are revoked explicitly.
GRANT chronixedu_audit_purger TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT USAGE, CREATE ON SCHEMA chronixedu_purge TO chronixedu_audit_purger;
ALTER FUNCTION chronixedu_purge.purge_school_audit_logs(uuid, uuid) OWNER TO chronixedu_audit_purger;
DO $$
DECLARE
  me text := current_user;
  r text;
BEGIN
  EXECUTE 'SET LOCAL ROLE chronixedu_audit_purger';
  EXECUTE 'REVOKE ALL ON FUNCTION chronixedu_purge.purge_school_audit_logs(uuid, uuid) FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION chronixedu_purge.purge_school_audit_logs(uuid, uuid) FROM %I', r);
    END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION chronixedu_purge.purge_school_audit_logs(uuid, uuid) TO %I', me);
  EXECUTE 'RESET ROLE';
END $$;
REVOKE USAGE, CREATE ON SCHEMA chronixedu_purge FROM chronixedu_audit_purger;
REVOKE chronixedu_audit_purger FROM CURRENT_USER;
