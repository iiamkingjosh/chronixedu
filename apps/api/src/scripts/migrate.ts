import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from '../db/client';

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function migrate() {
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
