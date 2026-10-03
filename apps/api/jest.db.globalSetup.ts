import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

/**
 * Rebuilds the public schema from /migrations. DESTRUCTIVE — so it refuses to
 * run unless the target is a local host AND the database name ends in "_test".
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for the DB test suite');
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(parsed.hostname) || !dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to rebuild ${parsed.hostname}/${dbName}: DB tests only run against a local database whose name ends in "_test".`
    );
  }

  const root = path.join(__dirname, '../..');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Every schema a migration creates must be dropped here, not only public. Migration 048 put
    // the audit purge function in chronixedu_purge; while this dropped public alone, a stale purge
    // function survived each local rebuild and a "revert to the old code" run still had it, so the
    // run measured leftovers rather than the code under test.
    await client.query('DROP SCHEMA IF EXISTS chronixedu_purge CASCADE;');
    // Migration 055's break-glass function for platform-admin two-factor.
    await client.query('DROP SCHEMA IF EXISTS chronixedu_two_factor CASCADE;');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await client.query(fs.readFileSync(path.join(root, 'scripts/sql/test_supabase_stubs.sql'), 'utf8'));
    const dir = path.join(root, 'migrations');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (process.env.C4A_ROLES === '1') {
      // The proposed grant set, applied exactly as it would ship. The password is local-only
      // and exists solely so the app pool can log in as the role; production's is set out of
      // band at cutover and never lives in the repo. Both guards above (local host, *_test
      // database) have already passed by this point.
      for (const role of ['chronixedu_app', 'chronixedu_login']) {
        await client.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF;
        END $$`);
        await client.query(`ALTER ROLE ${role} LOGIN PASSWORD 'c4a-local-test-only'`);
      }
      await client.query(fs.readFileSync(path.join(root, 'docs/c4a/grants.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
}
