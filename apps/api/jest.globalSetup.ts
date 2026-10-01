import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

// The same hazard as the two guards below, one layer further out: .env holds production's
// SendGrid, Termii and Paystack keys, and a run that loads them can email, text or charge for
// real. Measured 1 Oct 2026: each local run sent one real email through production SendGrid
// (a platform announcement to a fixture principal), and made no other outbound call. Emptied,
// not deleted, because most suites call dotenv.config themselves and dotenv never overwrites a
// variable that is set. A test that needs a provider sets a fake key and stubs the call, as
// feesPayout and payoutSettings do. The marker lets noOutsideWorldKeys.test.ts tell "emptied"
// from "never there".
for (const key of ['SENDGRID_API_KEY', 'TERMII_API_KEY', 'PAYSTACK_SECRET_KEY', 'SMS_ENABLED', 'SENTRY_DSN']) {
  process.env[key] = '';
}
process.env.OUTSIDE_WORLD_KEYS_EMPTIED = '1';

import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';

// These fixture IDs are hardcoded across all integration tests.
// They must exist in the database before tests run.
const SCHOOL_ID   = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID    = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const TEACHER_ID  = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';
const SESSION_ID  = 'e3e62132-16e4-4c1c-ad8b-9118579323c5';
const TERM_ID     = '3df9f000-f173-4307-a986-64516372c2a0';
const SUBJECT_ID  = '9ddb5e1d-c3ce-4205-ad0e-9ec584656e2d';
const FATIMA_ID   = '483dc14c-b865-45eb-99f9-fde8b2dbf16e';
const FATIMA_USER = 'ffffffff-0000-0000-0000-000000000001';

export default async function globalSetup(): Promise<void> {
  // These fixtures are only consumed by the DB-backed apps/api/tests/**
  // integration suite. src/__tests__/** mocks pg entirely and needs no real
  // connection — so when DATABASE_URL isn't set (e.g. CI's unit-only job,
  // which deliberately runs with no real credentials), skip seeding rather
  // than fail the whole run trying to connect.
  if (!process.env.DATABASE_URL) {
    return;
  }

  // AUDIT H-5: this seeds fixture rows into whatever DATABASE_URL points at —
  // which, via apps/api/.env, has historically been PRODUCTION. Refuse any
  // non-local database unless the operator explicitly names it as a target.
  const host = new URL(process.env.DATABASE_URL).hostname;
  const isLocal = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host);
  if (!isLocal && process.env.ALLOW_REMOTE_TEST_DB !== host) {
    throw new Error(
      `Refusing to seed integration fixtures into remote database "${host}". ` +
      `Point DATABASE_URL at a local/staging DB, or set ALLOW_REMOTE_TEST_DB=${host} ` +
      `if you are certain this is NOT production.`
    );
  }

  // The same hazard, one layer over: several suites (staff bulk import, student
  // registration) call supabaseAdmin.auth.admin.createUser, which creates REAL,
  // loginable identities on whatever Supabase project SUPABASE_URL names — and via
  // apps/api/.env that is production. A sweep on 2026-09-26 found 783 auth
  // identities with no matching users row, every one of them left behind by a test
  // run, and the ones predating 752db72 carry a password that was public in this
  // repo. CI already points at a local stub (127.0.0.1:54321); this stops a local
  // run from silently topping the pile up.
  if (process.env.SUPABASE_URL) {
    const sbHost = new URL(process.env.SUPABASE_URL).hostname;
    const sbIsLocal = ['localhost', '127.0.0.1', '::1', 'supabase', 'kong'].includes(sbHost);
    if (!sbIsLocal && process.env.ALLOW_REMOTE_TEST_SUPABASE !== sbHost) {
      throw new Error(
        `Refusing to run integration tests against remote Supabase Auth "${sbHost}". ` +
        `These suites create real login identities and do not clean them up. ` +
        `Point SUPABASE_URL at a local Supabase, or set ALLOW_REMOTE_TEST_SUPABASE=${sbHost} ` +
        `if you are certain this is NOT production.`
      );
    }
  }

  // Is Supabase Auth usable? Decided HERE, before any test file is collected, because
  // that is the only point at which a test can still be marked skipped. Jest chooses
  // `it` vs `it.skip` synchronously while collecting a file — before any beforeAll runs —
  // so a probe inside the suite can only ever produce `console.warn` + `return`, and an
  // early return is reported as PASSED. tests/resultEngine.test.ts did exactly that for
  // three and a half months; studentsBulkImport's five commit tests did it whenever Auth
  // was down, inflating `passed` by five.
  //
  // Handed to the test files through process.env: test environments are created after
  // globalSetup completes, from the parent's environment, so the value is visible at
  // collection time. Always written, empty when Auth works, so a value left over from a
  // previous shell cannot skip tests that could run.
  process.env.TEST_AUTH_UNAVAILABLE = await probeAuth();
  if (process.env.TEST_AUTH_UNAVAILABLE) {
    console.warn(`
[globalSetup] Supabase Auth unusable — Auth-dependent tests will be SKIPPED: ${process.env.TEST_AUTH_UNAVAILABLE}
`);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // 1. School
    await client.query(
      `INSERT INTO schools (id, name, slug, is_active, is_demo) VALUES ($1, 'Integration Test School', 'integration-test-school', false, false)
       ON CONFLICT DO NOTHING`,
      [SCHOOL_ID]
    );

    // 2. School settings (required by any route that reads academic/notification config)
    await client.query(
      `INSERT INTO school_settings (school_id, identity_config, academic_config, notification_config, report_config)
       VALUES (
         $1,
         '{"name":"Integration Test School","motto":"","logo_url":null,"stamp_url":null,"primary_colour":null,"secondary_colour":null}'::jsonb,
         '{"promotion_cutoff":40,"grading_scale":[{"grade":"A","min":70,"max":100,"label":"Excellent","remark":""},{"grade":"B","min":60,"max":69,"label":"Very Good","remark":""},{"grade":"C","min":50,"max":59,"label":"Good","remark":""},{"grade":"D","min":40,"max":49,"label":"Pass","remark":""},{"grade":"F","min":0,"max":39,"label":"Fail","remark":""}],"assessment_components":[{"name":"CA1","max_score":10,"weight":10,"display_order":1},{"name":"CA2","max_score":10,"weight":10,"display_order":2},{"name":"Mid-Term","max_score":10,"weight":10,"display_order":3},{"name":"Exam","max_score":70,"weight":70,"display_order":4}]}'::jsonb,
         '{}'::jsonb,
         '{"template":"classic","show_attendance":true}'::jsonb
       )
       ON CONFLICT DO NOTHING`,
      [SCHOOL_ID]
    );

    // 3. Teacher user (needed as FK for attendance, assignments, etc.)
    await client.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode)
       VALUES ($1, $2, 'teacher.math@chronixedu-test.com', 'test-hash', 'teacher', 'Math', 'Teacher', true, 'subject')
       ON CONFLICT DO NOTHING`,
      [TEACHER_ID, SCHOOL_ID]
    );

    // 4. Class (needed as FK for attendance, assignments, student enrollment, etc.)
    //    form_teacher_id = TEACHER_ID so the shared TEACHER_ID fixture is authorized
    //    to mark attendance for CLASS_ID (attendance/mark requires the caller be the
    //    class's form teacher or hold a teacher_assignments row for it).
    //    ON CONFLICT DO UPDATE (not DO NOTHING) so this stays correct even if the row
    //    already existed from a previous test run with form_teacher_id still null.
    await client.query(
      `INSERT INTO classes (id, school_id, name, level, stream, form_teacher_id)
       VALUES ($1, $2, 'JSS 1A', 'Junior', null, $3)
       ON CONFLICT (id) DO UPDATE SET form_teacher_id = EXCLUDED.form_teacher_id`,
      [CLASS_ID, SCHOOL_ID, TEACHER_ID]
    );

    // 5. Academic session (required by student_classes FK + active-term lookup)
    await client.query(
      `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, '2025/2026 Academic Year', '2025-08-31', '2026-06-30', true)
       ON CONFLICT DO NOTHING`,
      [SESSION_ID, SCHOOL_ID]
    );

    // 6. First Term (covers 2025-08-31..2025-12-20 — used by attendance + behaviour routes)
    //    is_current=true so getActiveTerm() returns this term
    await client.query(
      `INSERT INTO terms (id, session_id, school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, $3, 'First Term', '2025-08-31', '2025-12-20', true)
       ON CONFLICT DO NOTHING`,
      [TERM_ID, SESSION_ID, SCHOOL_ID]
    );

    // 7. Mathematics subject (SUBJECT_ID = MATH_ID used in assignments + resultEngine)
    await client.query(
      `INSERT INTO subjects (id, school_id, name, code)
       VALUES ($1, $2, 'Mathematics', 'MATH')
       ON CONFLICT DO NOTHING`,
      [SUBJECT_ID, SCHOOL_ID]
    );

    // 8. Fatima user + student (FATIMA_ID used in offlineSync to mark attendance)
    await client.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode)
       VALUES ($1, $2, 'fatima.test@chronixedu-test.com', 'test-hash', 'student', 'Fatima', 'Test', true, 'subject')
       ON CONFLICT DO NOTHING`,
      [FATIMA_USER, SCHOOL_ID]
    );
    await client.query(
      `INSERT INTO students (id, school_id, user_id, admission_no)
       VALUES ($1, $2, $3, 'TEST-FATIMA-001')
       ON CONFLICT DO NOTHING`,
      [FATIMA_ID, SCHOOL_ID, FATIMA_USER]
    );

    // 9. A platform super_admin — system jobs (trial expiry) attribute audit rows to one.
    await client.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ('eeeeeeee-0000-4000-8000-000000000001', NULL, 'system.admin@chronixedu-test.com', 'test-hash', 'super_admin', 'System', 'Admin', true, 'subject', false)
       ON CONFLICT DO NOTHING`
    );
  } finally {
    await client.end();
  }
}

/**
 * Empty string when Auth is usable; otherwise the reason it is not.
 *
 * Retried, because a skip has to mean "Auth is unavailable", not "one connection
 * dropped". Observed 28 Sep 2026 against a healthy local stack: a single probe returned
 * `fetch failed` and skipped five tests that could have run. Three attempts 500ms apart
 * separate a lost packet from a stack that is actually down, and the reason reported is
 * the last attempt's, so a real outage still says what it is.
 */
async function probeAuth(): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set';
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let reason = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (!error) return '';
      reason = `${url}: ${error.message} (after ${attempt} attempt${attempt > 1 ? 's' : ''}). `
        + 'Point SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY at the same project.';
    } catch (err) {
      reason = `${url}: ${(err as Error).message} (after ${attempt} attempt${attempt > 1 ? 's' : ''})`;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 500));
  }
  return reason;
}
