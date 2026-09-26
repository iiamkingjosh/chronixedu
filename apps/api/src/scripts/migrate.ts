import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from '../db/client';

/**
 * Resolved, not assumed. In production this runs as dist/scripts/migrate.js inside a
 * container whose build command is scoped to apps/api, so the repo-root `migrations/`
 * directory may not be present at all — the build copies it to dist/migrations for
 * exactly that reason. In dev it runs from src/scripts via ts-node, where the only
 * copy is the one at the repo root. Try the self-contained location first and fall
 * back, rather than trusting a fixed number of `..` segments to mean the same thing
 * in both layouts.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    path.join(__dirname, '../migrations'),          // dist/scripts -> dist/migrations
    path.join(__dirname, '../../../../migrations'), // -> repo root/migrations
  ];
  // Existence is not enough: an empty, untracked apps/api/src/migrations/ directory
  // exists in some working copies, and matching it made this report "all migrations
  // up to date" after reading zero files — a silent no-op that looks like success.
  // A directory only counts if it actually holds migrations.
  const hasMigrations = (d: string): boolean => {
    try {
      return fs.statSync(d).isDirectory() && fs.readdirSync(d).some(f => f.endsWith('.sql'));
    } catch {
      return false;
    }
  };
  const found = candidates.find(hasMigrations);
  if (!found) {
    throw new Error(
      'Could not locate a migrations directory containing .sql files. Looked in: ' + candidates.join(' | ') +
      '. If this is a production container, the build step that copies migrations into dist did not run.'
    );
  }
  return found;
}

const MIGRATIONS_DIR = resolveMigrationsDir();

async function migrate() {
  // Printed so a deploy log shows which copy was used, not just that it worked.
  console.log(`migrations dir: ${MIGRATIONS_DIR}`);

  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const pending = files.filter(f => !appliedSet.has(f));

  if (pending.length === 0) {
    console.log('✓ All migrations up to date');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`→ Applying ${file}…`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${file} failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(`✓ ${pending.length} migration(s) applied`);
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration runner error:', err);
  process.exit(1);
});
