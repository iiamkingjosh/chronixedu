import { Pool } from 'pg';
import { logger } from '../config/logger';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Without this, an idle pooled connection dropped server-side (e.g. Supabase's
// PgBouncer reclaiming it) emits an unhandled 'error' event on the pool, which
// Node treats as an uncaught exception and crashes the whole process. Logging
// it here lets pg silently remove the dead client and open a fresh one on the
// next checkout instead.
pool.on('error', (err) => {
  logger.error('pg_pool_idle_client_error', { error: err instanceof Error ? err.message : String(err) });
});

export default pool;
