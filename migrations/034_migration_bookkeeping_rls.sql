-- 034: RLS on the migration runner's own bookkeeping tables.
--
-- `schema_migrations` was the one table in `public` without row level security. It was
-- not an oversight anyone decided on — tenantIsolation.db.test.ts carved it out BY NAME
-- (`AND c.relname <> 'schema_migrations'`), so the suite asserting "every public table
-- has RLS enabled" quietly meant "every public table except this one". Its contents are
-- only filenames and timestamps, so the exposure is close to nil, but an invariant with
-- a silent asterisk is one nobody re-examines. Doctrine 2: RLS is defence in depth, so
-- the Supabase REST endpoint exposes nothing.
--
-- Both tables are normally created by the migrate runner itself (src/scripts/migrate.ts)
-- rather than by a migration, so they can be absent when CI rebuilds the schema from
-- /migrations alone. Created here too, so the schema is identical either way.
--
-- No policy is attached deliberately. RLS with no policy denies every non-owning role;
-- the API's pool connects as the table owner and bypasses RLS, so the runner is
-- unaffected. These hold no tenant data, so there is no school_id and no tenant policy.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id             BIGSERIAL PRIMARY KEY,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  migrations_dir TEXT        NOT NULL,
  file_count     INTEGER     NOT NULL,
  applied_count  INTEGER     NOT NULL,
  commit_sha     TEXT
);

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_runs    ENABLE ROW LEVEL SECURITY;
