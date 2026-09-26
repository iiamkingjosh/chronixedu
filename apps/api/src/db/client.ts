import fs from 'fs';
import path from 'path';
import { Pool, type PoolConfig } from 'pg';
import { logger } from '../config/logger';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

/**
 * Decides transport security explicitly, rather than letting whatever `sslmode`
 * happens to be in DATABASE_URL decide it.
 *
 * This pool previously passed no `ssl` option at all, and DATABASE_URL carries no
 * `sslmode`. node-postgres only performs the SSLRequest handshake when `ssl` is
 * truthy, so the production connection was a plain TCP socket — verified on
 * 2026-09-26: `socket=Socket TLS=NONE` against the live pooler, versus
 * `TLSSocket TLSv1.3` once `ssl` is set. Every query between Railway and Supabase,
 * password hashes and student PII included, crossed the public internet in
 * cleartext. Deciding it here means an env-var edit cannot silently undo it.
 *
 * Verification: Supabase's pooler presents a certificate chaining to a private
 * root, so neither `ssl: true` nor the system CA bundle can verify it — both fail
 * with "self-signed certificate in certificate chain". Set PGSSLROOTCERT to
 * Supabase's CA bundle (Dashboard → Settings → Database → SSL Configuration) to get
 * a fully verified connection; without it the link is encrypted but the server is
 * unauthenticated, which stops passive interception but not an active MITM. That
 * gap is logged loudly at startup so it cannot be forgotten.
 */
/**
 * The CA that ships with the build. Resolves to apps/api/certs in the repo (from
 * src/db/) and to dist/certs in the image (from dist/db/), because the build copies
 * certs/ into dist/ the way it already copies templates and migrations.
 *
 * Returns undefined rather than a missing path, so a checkout without the bundle falls
 * through to the warning instead of throwing.
 */
function defaultCaPath(): string | undefined {
  const bundled = path.join(__dirname, '../certs/supabase-ca.crt');
  return fs.existsSync(bundled) ? bundled : undefined;
}

function resolveSsl(): PoolConfig['ssl'] {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined; // malformed URL — let pg produce its own error
  }

  // Local Postgres (dev, CI, the DB test container) serves no TLS at all.
  if (LOCAL_HOSTS.has(host)) return undefined;

  // PGSSLROOTCERT wins if set; otherwise the CA bundled with the build. Shipping the
  // bundle means a fresh deploy is verified by default, rather than only once somebody
  // remembers to set a variable.
  const caPath = process.env.PGSSLROOTCERT ?? defaultCaPath();
  if (caPath) {
    if (!fs.existsSync(caPath)) {
      // Fails closed: a path that resolves in the repo and not in the image takes the
      // API down at boot. That is the intended trade — an unverified connection nobody
      // notices is worse than a loud failure — and it is why the build copies certs/
      // into dist/ and why apps/api/certs/** belongs in the watch patterns.
      throw new Error(`PGSSLROOTCERT is set to "${caPath}" but no such file exists — refusing to fall back to an unverified connection.`);
    }
    // Logged on the SUCCESS branch too: a working config that says nothing is
    // indistinguishable from one that never ran, which is the failure this session has
    // hit four times.
    logger.info('pg_tls_verified', { host, caPath });
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }

  // Only reachable when the bundled CA is missing AND PGSSLROOTCERT is unset.
  logger.warn('pg_tls_unverified', {
    host,
    detail: 'Connection is encrypted but the server certificate is not verified. Set PGSSLROOTCERT to Supabase\'s CA bundle for a verified connection.',
  });
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
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
