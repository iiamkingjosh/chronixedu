// Point the app's pool at the disposable test DB before any module loads it.
//
// C-4a role mode (jest.db.roles.config.js sets C4A_ROLES=1): the app pool connects as
// chronixedu_app, holding exactly docs/c4a/grants.sql, while TEST_DATABASE_URL stays the
// owner — used only by seed(), which TRUNCATEs and so must not run as the app role. Every
// failure in this mode is a route or test doing something the proposed grants forbid.
if (process.env.C4A_ROLES === '1') {
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.username = 'chronixedu_app';
  u.password = 'c4a-local-test-only';
  process.env.DATABASE_URL = u.toString();
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'db-test-secret-db-test-secret-0001';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_PUBLISHABLE_KEY ??= 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.ROOT_ADMIN_EMAIL ??= 'root@chronix.test';
delete process.env.REDIS_URL;
