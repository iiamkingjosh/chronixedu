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
  } finally {
    await client.end();
  }
}
