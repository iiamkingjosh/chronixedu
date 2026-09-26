-- 036: make doctrine 6's "audit_logs has no DELETE" true in the database.
--
-- It was not. The table's policies are service_role_bypass (ALL), tenant_isolation
-- (SELECT) and insert (INSERT) — there is no DELETE policy, which stops every role
-- that RLS applies to. But relforcerowsecurity is FALSE and the API's pool connects as
-- the table owner, which bypasses RLS entirely. So the append-only guarantee was a
-- sentence in CLAUDE.md, not a property of the database, and any code or script running
-- as the app could have deleted audit rows.
--
-- This was found while scoping a cleanup that would have needed to delete 212 audit
-- rows belonging to fixture schools. Those rows genuinely do not matter, which is
-- exactly what makes them a bad precedent: the first exception is always the reasonable
-- one, and afterwards the rule is "delete audit rows when they seem unimportant" — a
-- judgement rather than a guarantee. The response to finding an unenforced invariant is
-- to enforce it.
--
-- A statement-level BEFORE trigger, so it fires even when the DELETE matches no rows,
-- and so the error names the reason rather than silently discarding the statement the
-- way a DO INSTEAD NOTHING rule would. UPDATE is covered too: an append-only log that
-- can be rewritten in place is not append-only.
--
-- Nothing in the codebase deletes from audit_logs, so this breaks no existing path.
-- A genuine future need (a retention policy, a data-subject erasure request under NDPR)
-- should drop this trigger explicitly in its own migration, which leaves a record of
-- the decision — which is the point.

CREATE OR REPLACE FUNCTION audit_logs_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (CLAUDE.md doctrine 6): % is not permitted', TG_OP
    USING HINT = 'If a retention or erasure policy genuinely requires this, drop trigger audit_logs_append_only in its own migration so the decision is recorded.';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE DELETE OR UPDATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_forbid_mutation();
