// Point the app's pool at the disposable test DB before any module loads it.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'db-test-secret-db-test-secret-0001';
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_PUBLISHABLE_KEY ??= 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.ROOT_ADMIN_EMAIL ??= 'root@chronix.test';
delete process.env.REDIS_URL;
