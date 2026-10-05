#!/usr/bin/env node
'use strict';
/**
 * Delete one school's data — the deletion half of the promise in the Data Processing
 * Agreement and Terms §22 ("permanently delete … within 90 days" of termination).
 * Runbook: docs/data-deletion-runbook.md. Read it before running this against anything real.
 *
 *   node apps/api/scripts/delete-school-data.js --school <uuid>                  # dry run: prints the plan
 *   node apps/api/scripts/delete-school-data.js --school <uuid> --execute --confirm <school-slug> \
 *        --operator <super-admin email> --with-supabase
 *   node apps/api/scripts/delete-school-data.js --all-except <uuid>              # every school but one
 *   node apps/api/scripts/delete-school-data.js --all-except <uuid> --execute --confirm <kept-school-slug> \
 *        --confirm-count <number to delete> --operator <super-admin email> --with-supabase
 *   --all-except <uuid>  delete every school except this one. The list is built from the database at
 *                        run time, never typed out. At the end, exactly one school must remain, and it
 *                        must be this one, checked by id: a count of 1 is also what deleting the wrong
 *                        schools would leave.
 *   --allow-host <host>  required for a non-local database (must equal the DATABASE_URL host)
 *   --operator <email>   the Chronix super admin running it; named on the purge record
 *                        (platform_audit_logs SCHOOL_AUDIT_PURGED). Required with --execute.
 *   --with-supabase      delete the users' Supabase Auth accounts and the school's Storage files
 *                        too, BEFORE the database step (needs SUPABASE_URL and
 *                        SUPABASE_SERVICE_ROLE_KEY; the key is never printed)
 *   --skip-supabase      leave them, and print what was left — the only time the Auth ids are
 *                        printed, since the users rows that list them are about to go
 *
 * "Auth accounts" means users that really have a Supabase Auth login (an auth.users row with the
 * same id), read from the database before anything changes. It used to mean every users row, so a
 * school of 109 fixture users with no logins was reported as "109 Auth accounts", and 109 deletes
 * were sent for accounts that did not exist; one network blip on one of them stopped the whole
 * run (2 Oct 2026). Where the database has no auth schema to read, every user id is tried, and the
 * plan says so.
 *   --execute needs exactly one of the two, so leaving them behind is a choice, not an omission.
 *
 * A completed run leaves ZERO rows for the school in every table — checked inside the same
 * transaction, which rolls back otherwise. audit_logs is removed through the one path migration
 * 048 opens, chronixedu_purge.purge_school_audit_logs(school, operator); a plain DELETE on it is
 * still refused. The record of that purge (platform_audit_logs, target_school_id NULL, the id in
 * metadata) is deliberately not matched by anything here, so it survives the deletion.
 *
 * Tables without a school_id are reached through the school's students, users, terms, sessions,
 * assignments or assessment configs. email_queue has no link to a school at all and is matched
 * on the school's users' email addresses.
 *
 * Suspend, wait, re-check (4 Oct 2026, docs/AUDIT-2026-09.md fix (a2)). The API caches a school's
 * row in its own memory, and whether an account is active in Redis. This script can clear neither:
 * it is a separate process, and it is given no Redis access on purpose. So --execute suspends every
 * school it will delete, waits out the longest cache time in src/config/cacheTimes.json, and only
 * then deletes. By then every cached copy says suspended, and the API refuses the school's users.
 * Each school's transaction locks its row and refuses unless it is still suspended, so a school
 * reactivated during the wait is never deleted. One wait covers every school in a run: once all are
 * suspended, nothing can cache one as active again. If a run stops after suspending, it prints every
 * school it suspended, so the state is recoverable rather than found later.
 */
const { Client } = require('pg');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const S = `(SELECT id FROM students WHERE school_id = $1)`;
const U = `(SELECT id FROM users WHERE school_id = $1)`;
const T = `(SELECT id FROM terms WHERE school_id = $1)`;
const SES = `(SELECT id FROM academic_sessions WHERE school_id = $1)`;
const own = (table) => ({ table, where: `school_id = $1` });

/**
 * Every table holding the school's rows, children before parents — the order the foreign keys
 * require. The last four are the audit tables, the users they named, and the school itself.
 */
const STEPS = [
  { table: 'assignment_submissions', where: `assignment_id IN (SELECT id FROM assignments WHERE school_id = $1) OR student_id IN ${S}` },
  own('payments'),
  own('fee_invoices'),
  own('fee_structures'),
  own('scores'),
  { table: 'assessment_components', where: `config_id IN (SELECT id FROM assessment_configs WHERE school_id = $1)` },
  own('assessment_configs'),
  own('subject_result_status'),
  own('result_status'),
  own('report_cards'),
  { table: 'class_teacher_comments', where: `student_id IN ${S} OR term_id IN ${T}` },
  { table: 'principal_remarks', where: `student_id IN ${S} OR term_id IN ${T}` },
  own('attendance_alerts'),
  own('attendance'),
  own('behaviour_records'),
  own('assignments'),
  own('timetable_slots'),
  own('teacher_assignments'),
  own('notices'),
  own('announcements'),
  own('messages'),
  own('notification_logs'),
  { table: 'notifications', where: `user_id IN ${U}` },
  // Two-factor credentials (migration 055) go with their user. Only platform admins, who have no
  // school, can enrol today, so these match nothing; if school staff ever can, deletion already
  // covers them and the zero-rows check proves it. Deleting an active user_totp row writes a
  // TWO_FACTOR_REMOVED record with target_user_id NULL, which the platform_audit_logs step below
  // does not match, so the record of the removal survives the deletion.
  { table: 'user_recovery_codes', where: `user_id IN ${U}` },
  { table: 'user_totp', where: `user_id IN ${U}` },
  // Replaced passwords kept for the reuse rule (migration 060) go with their user too.
  { table: 'password_history', where: `user_id IN ${U}` },
  { table: 'email_queue', where: `to_email IN (SELECT email FROM users WHERE school_id = $1)` },
  own('school_analytics_snapshots'),
  { table: 'parent_students', where: `student_id IN ${S} OR parent_id IN ${U}` },
  { table: 'student_classes', where: `student_id IN ${S} OR session_id IN ${SES}` },
  own('students'),
  own('classes'),
  own('subjects'),
  own('terms'),
  own('academic_sessions'),
  own('support_sessions'),
  own('onboarding_sessions'),
  // References platform_subscriptions, so it goes first (child before parent).
  own('platform_subscription_payments'),
  own('platform_subscriptions'),
  own('school_settings'),
  // Removed only through migration 048's function; a plain DELETE is refused by the trigger.
  // user_id IN U is required, not generous: those users are deleted next, and audit_logs.user_id
  // references users.
  { table: 'audit_logs', where: `school_id = $1 OR user_id IN ${U}`, purge: true },
  // No guard on this table (measured 1 Oct 2026: no triggers), only foreign keys. The purge record
  // has target_school_id NULL and a Chronix admin as platform_admin_id, so this does not match it.
  { table: 'platform_audit_logs', where: `target_school_id = $1 OR target_user_id IN ${U} OR platform_admin_id IN ${U}` },
  { table: 'users', where: `school_id = $1` },
  { table: 'schools', where: `id = $1` },
];

/**
 * Every other table, and why this script leaves it alone. schoolDeletion.db.test.ts fails if a
 * table is in neither list — a new table holding school data must be added to STEPS (or
 * here, with a reason) before this script can be trusted again.
 */
const NOT_DELETED = {
  platform_announcements: 'Platform-wide notices written by Chronix; no school data.',
  platform_metrics_snapshots: 'Platform-wide aggregate counts; no per-school rows.',
  platform_pricing_config: 'Chronix price list; no school data.',
  schema_migrations: 'Migration bookkeeping; no school data.',
  migration_runs: 'Migration bookkeeping; no school data.',
  login_challenges: 'Minutes-long sign-in challenges for platform admins, who have no school (migration 057). Removed with their user by ON DELETE CASCADE, and pruned at each new sign-in.',
};

async function count(client, table, where, schoolId) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [schoolId]);
  return rows[0].n;
}

/** Rows for the school, table by table, in STEPS order. */
async function countAll(client, schoolId) {
  const out = [];
  for (const s of STEPS) out.push({ table: s.table, rows: await count(client, s.table, s.where, schoolId) });
  return out;
}

/**
 * Where the API stores a school's files: src/config/storagePrefixes.json, the one list the data
 * export reads too (3 Oct 2026), so a path is exported and deleted together or neither.
 *   school-assets (SUPABASE_STORAGE_BUCKET): schools/<id>/ — logo, signature, stamp, student
 *     photos, staff signatures, assignment attachments and submissions
 *   report-cards: <id>/ (report cards), receipts/<id>/, transcripts/<id>/
 * A new upload path goes in that file; storagePrefixes.test.ts fails until it does.
 */
const STORAGE_PREFIX_CONFIG = require('../src/config/storagePrefixes.json');

function storagePrefixes(schoolId) {
  const assets = process.env.SUPABASE_STORAGE_BUCKET || 'school-assets';
  return STORAGE_PREFIX_CONFIG.prefixes.map(p => ({
    bucket: p.bucket === 'assets' ? assets : p.bucket,
    prefix: p.template.replace('{schoolId}', schoolId),
  }));
}

/** The school's stored files, read from storage.objects; null where this database has no Storage. */
async function listStorageObjects(client, schoolId) {
  const has = (await client.query(`SELECT to_regclass('storage.objects') IS NOT NULL AS ok`)).rows[0].ok;
  if (!has) return null;
  const out = [];
  for (const { bucket, prefix } of storagePrefixes(schoolId)) {
    const { rows } = await client.query(
      `SELECT name FROM storage.objects WHERE bucket_id = $1 AND starts_with(name, $2) ORDER BY name`, [bucket, prefix]);
    for (const r of rows) out.push({ bucket, name: r.name });
  }
  return out;
}

/**
 * Every email address and phone number this run removes from our database. Copies of them
 * outlive the run at SendGrid (suppression lists never expire) and Termii (SMS history), and
 * after the run nothing on our side can say which addresses they were.
 */
async function listContacts(client, schoolId) {
  const emails = (await client.query(
    `SELECT DISTINCT lower(trim(e)) AS v FROM (
       SELECT email AS e FROM users WHERE school_id = $1
       UNION ALL SELECT email FROM schools WHERE id = $1
       UNION ALL SELECT to_email FROM email_queue WHERE to_email IN (SELECT email FROM users WHERE school_id = $1)
     ) x WHERE e IS NOT NULL AND trim(e) <> '' ORDER BY 1`, [schoolId])).rows.map(r => r.v);
  const phones = (await client.query(
    `SELECT DISTINCT trim(p) AS v FROM (
       SELECT phone AS p FROM users WHERE school_id = $1
       UNION ALL SELECT phone FROM schools WHERE id = $1
       UNION ALL SELECT emergency_contact_phone FROM students WHERE school_id = $1
     ) x WHERE p IS NOT NULL AND trim(p) <> '' ORDER BY 1`, [schoolId])).rows.map(r => r.v);
  return { emails, phones };
}

/**
 * The school's users that have a Supabase Auth login, or null where this database has no auth
 * schema to read (then every user id is a candidate). A users row is not a login: production held
 * 239 users rows and 7 logins on 2 Oct 2026.
 */
async function listAuthAccounts(client, schoolId) {
  const has = (await client.query(`SELECT to_regclass('auth.users') IS NOT NULL AS ok`)).rows[0].ok;
  if (!has) return null;
  return (await client.query(
    `SELECT u.id FROM users u JOIN auth.users a ON a.id = u.id WHERE u.school_id = $1 ORDER BY u.id`, [schoolId])).rows.map(r => r.id);
}

/** What would be deleted, changing nothing. `school` is null once the school row is gone. */
async function planSchoolDeletion(client, schoolId) {
  const school = (await client.query(`SELECT id, slug, name FROM schools WHERE id = $1`, [schoolId])).rows[0] || null;
  const steps = await countAll(client, schoolId);
  const total = steps.reduce((a, s) => a + s.rows, 0);
  const userIds = (await client.query(`SELECT id FROM users WHERE school_id = $1 ORDER BY id`, [schoolId])).rows.map(r => r.id);
  const authAccounts = await listAuthAccounts(client, schoolId);
  // The ids the Auth step acts on: real logins where they can be read, otherwise every user.
  const authUserIds = authAccounts ?? userIds;
  const storageObjects = await listStorageObjects(client, schoolId);
  const contacts = await listContacts(client, schoolId);
  return { school, steps, total, userIds, authAccounts, authUserIds, storageObjects, ...contacts };
}

/** The plan's Auth line: a count of real logins, or why it could not be counted. */
function describeAuthAccounts(plan) {
  if (plan.authAccounts === null) {
    return `Supabase Auth accounts: not checked — this database has no auth schema; all ${plan.userIds.length} user id(s) will be tried`;
  }
  const have = plan.authAccounts.length, users = plan.userIds.length;
  // "Every user has a login" is vacuously true of a school with no users, and said so on 2 Oct 2026.
  if (users === 0) return 'Supabase Auth accounts: 0 (the school has no users)';
  if (have === users) return `Supabase Auth accounts: ${have} (every user has a login)`;
  return `Supabase Auth accounts: ${have} (of ${users} users; the other ${users - have} have no login)`;
}

/**
 * Deletes the given Supabase Auth accounts through the admin API. "Not found" counts as already
 * gone. Any other error is retried, `attempts` times in all, waiting `waitMs` x the attempt number
 * between tries, because one TLS handshake failure from Lagos stopped a run on 2 Oct 2026. An error
 * that persists is returned as a failure, and the caller stops before the database: a login left
 * behind with no app account is the worse outcome.
 */
async function deleteAuthAccounts(admin, ids, { attempts = 3, waitMs = 1000 } = {}) {
  const failures = [];
  for (const id of ids) {
    for (let attempt = 1; ; attempt++) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (!error || /not found/i.test(error.message)) break;
      if (attempt >= attempts) { failures.push({ id, message: error.message }); break; }
      await new Promise(resolve => setTimeout(resolve, waitMs * attempt));
    }
  }
  return failures;
}

/** The cache times the API answers from without the database; the wait below outlasts all of them. */
const CACHE_TIMES = require('../src/config/cacheTimes.json');

/** Added to the longest cache time, so the wait ends after the last cached copy expires, not with it. */
const WAIT_MARGIN_SECONDS = 15;

/** How long to wait between suspending and deleting: the longest cache time, plus the margin. */
function deletionWaitSeconds() {
  const times = Object.entries(CACHE_TIMES).filter(([k]) => k.endsWith('_seconds')).map(([, v]) => v);
  return Math.max(...times) + WAIT_MARGIN_SECONDS;
}

/** Suspends every listed school that is still active, and returns the ids this call changed. */
async function suspendSchools(client, ids) {
  const { rows } = await client.query(
    `UPDATE schools SET is_active = false WHERE id = ANY($1::uuid[]) AND is_active RETURNING id`, [ids]);
  return rows.map(r => r.id);
}

/** Every school except the one to keep, oldest first. Refuses, changing nothing, if that one is missing. */
async function schoolsExcept(client, keepId) {
  const keep = (await client.query(`SELECT id, slug, name FROM schools WHERE id = $1`, [keepId])).rows[0];
  if (!keep) throw new Error(`Nothing was changed. There is no school ${keepId} to keep.`);
  const targets = (await client.query(
    `SELECT id, slug, name FROM schools WHERE id <> $1 ORDER BY created_at, id`, [keepId])).rows;
  return { keep, targets };
}

/** After an --all-except run: exactly one school left, and it is the one kept, by id. */
async function assertOnlySchoolLeft(client, keepId) {
  const ids = (await client.query(`SELECT id FROM schools ORDER BY id`)).rows.map(r => r.id);
  if (ids.length !== 1 || ids[0] !== keepId) {
    throw new Error(`Expected exactly one school left, ${keepId}; found ${ids.length}: ${ids.join(', ') || 'none'}.`);
  }
}

/**
 * Suspends the schools, waits, then deletes them one at a time, each in its own transaction.
 *  - `beforeDatabase(id)` runs before each school's transaction (the Supabase step).
 *  - `sleep(ms)` is injected so tests do not wait five minutes; the length comes from
 *    deletionWaitSeconds(), never from the caller.
 * On any failure after suspending, it prints which schools were deleted and every school this run
 * suspended that is still there, then rethrows.
 */
async function deleteSchools(client, schools, { operatorId, beforeDatabase = async () => {}, sleep, log = console.log }) {
  const ids = schools.map(s => s.id);
  const suspended = await suspendSchools(client, ids);
  log(`Suspended ${suspended.length} school(s) (the other ${ids.length - suspended.length} were already suspended):`);
  for (const id of suspended) log(`  ${id}`);
  const waitSeconds = deletionWaitSeconds();
  log(`Waiting ${waitSeconds} s for every cached copy to expire (the longest cache time in src/config/cacheTimes.json, plus ${WAIT_MARGIN_SECONDS} s)…`);
  await sleep(waitSeconds * 1000);

  const deleted = [];
  try {
    for (const s of schools) {
      await beforeDatabase(s.id);
      await executeSchoolDeletion(client, s.id, operatorId);
      deleted.push(s.id);
      log(`Deleted ${s.slug} (${s.id}): 0 rows left in every table, checked inside its transaction. ${deleted.length} of ${schools.length}.`);
    }
  } catch (err) {
    const left = (await client.query(
      `SELECT id FROM schools WHERE id = ANY($1::uuid[]) AND NOT is_active ORDER BY id`, [suspended])).rows.map(r => r.id);
    log(`STOPPED after deleting ${deleted.length} of ${schools.length}.`);
    log(`These ${left.length} school(s) were suspended by this run and are still suspended. Rerun to finish, or reactivate any you meant to keep:`);
    for (const id of left) log(`  ${id}`);
    throw err;
  }
  return { suspended, deleted, waitSeconds };
}

/** The super admin who runs the deletion, by email. The purge function checks the same rule. */
async function resolveOperator(client, email) {
  const { rows } = await client.query(
    `SELECT id FROM users WHERE lower(email) = lower($1) AND role = 'super_admin' AND is_active AND school_id IS NULL`, [email]);
  if (!rows[0]) throw new Error(`Nothing was changed. --operator ${email} is not an active Chronix super admin.`);
  return rows[0].id;
}

/**
 * Delete every row the plan lists, in one transaction, and prove it: the transaction recounts
 * every table before it commits, and rolls back unless every count is zero. It first locks the
 * school's row and refuses unless the school is suspended, so a school reactivated after
 * deleteSchools suspended it is never deleted.
 */
async function executeSchoolDeletion(client, schoolId, operatorId) {
  const plan = await planSchoolDeletion(client, schoolId);
  if (!plan.school) throw new Error(`No school with id ${schoolId}`);
  await client.query('BEGIN');
  try {
    const locked = (await client.query(`SELECT is_active FROM schools WHERE id = $1 FOR UPDATE`, [schoolId])).rows[0];
    if (!locked) throw new Error(`No school with id ${schoolId}`);
    if (locked.is_active) {
      throw new Error(`School ${schoolId} is active, so nothing was deleted. It must be suspended, and stay suspended for ${deletionWaitSeconds()} s, before it is deleted: rerun.`);
    }
    const deleted = {};
    for (const s of STEPS) {
      if (s.purge) {
        const { rows } = await client.query(
          `SELECT chronixedu_purge.purge_school_audit_logs($1, $2) AS n`, [schoolId, operatorId]);
        deleted[s.table] = rows[0].n;
      } else {
        deleted[s.table] = (await client.query(`DELETE FROM ${s.table} WHERE ${s.where}`, [schoolId])).rowCount;
      }
    }
    const remaining = (await countAll(client, schoolId)).filter(s => s.rows > 0);
    if (remaining.length) {
      throw new Error(`Rows remained after deletion, so nothing was deleted: ${remaining.map(s => `${s.table} ${s.rows}`).join(', ')}`);
    }
    await client.query('COMMIT');
    return { ...plan, deleted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function printContacts(plan) {
  console.log('Copy these now: after the run they exist nowhere in our database.');
  console.log(`  SendGrid: remove each from Suppressions (bounces, blocks, spam reports, unsubscribes) — ${plan.emails.length}:`);
  for (const e of plan.emails) console.log(`    ${e}`);
  console.log(`  Termii: name each in the deletion request to Termii — ${plan.phones.length}:`);
  for (const p of plan.phones) console.log(`    ${p}`);
}

/** Prints one school's plan: the rows it would delete, its logins and its stored files. */
function printPlan(plan) {
  const files = plan.storageObjects;
  console.log(`School: ${plan.school.name} (${plan.school.slug}, ${plan.school.id})`);
  for (const s of plan.steps) if (s.rows) console.log(`  delete ${String(s.rows).padStart(7)}  ${s.table}`);
  console.log(`  ${describeAuthAccounts(plan)}`);
  console.log(`  Supabase Storage files: ${files === null ? 'not checked — this database has no storage schema' : files.length}`);
}

/**
 * The Supabase step for one school, run just before its database transaction. Supabase goes FIRST:
 * the Auth ids come from the users rows the transaction is about to delete, so once it commits a
 * second run can no longer find them. An account missed here would be an orphan holding an email
 * address that nothing points to. Deleting them first, and stopping if any fails, keeps the run
 * repeatable.
 */
async function supabaseStep(client, admin, schoolId) {
  const plan = await planSchoolDeletion(client, schoolId);
  const files = plan.storageObjects;
  if (!admin) {
    if (plan.authUserIds.length || (files && files.length)) {
      console.log(`  --skip-supabase: NOT deleted for ${schoolId}, and after this run the database no longer lists them. Keep this list:`);
      for (const id of plan.authUserIds) console.log(`    auth ${id}`);
      for (const f of files || []) console.log(`    file ${f.bucket}/${f.name}`);
    }
    return;
  }
  const failures = await deleteAuthAccounts(admin, plan.authUserIds);
  for (const f of failures) console.error(`  auth ${f.id}: ${f.message} (after 3 attempts)`);
  if (failures.length) throw new Error(`${failures.length} Auth account(s) could not be deleted; the database was NOT touched for ${schoolId}. Fix and rerun — it is safe to repeat.`);

  // Through the Storage API — deleting storage.objects rows directly would leave the files.
  for (const bucket of [...new Set((files || []).map(f => f.bucket))]) {
    const names = files.filter(f => f.bucket === bucket).map(f => f.name);
    for (let i = 0; i < names.length; i += 100) {
      const { error } = await admin.storage.from(bucket).remove(names.slice(i, i + 100));
      if (error) throw new Error(`Storage ${bucket}: ${error.message}; the database was NOT touched for ${schoolId}. Rerun — it is safe to repeat.`);
    }
  }
  const left = await listStorageObjects(client, schoolId);
  if (left && left.length) throw new Error(`${left.length} stored file(s) still present after removal; the database was NOT touched for ${schoolId}.`);
}

async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
  const schoolId = arg('--school');
  const keepId = arg('--all-except');
  const execute = process.argv.includes('--execute');
  const confirm = arg('--confirm');
  const confirmCount = arg('--confirm-count');
  const operatorEmail = arg('--operator');
  const allowHost = arg('--allow-host');
  const withSupabase = process.argv.includes('--with-supabase');
  const skipSupabase = process.argv.includes('--skip-supabase');
  if (!!schoolId === !!keepId) throw new Error('Give exactly one of --school <uuid> or --all-except <uuid>.');
  if (!UUID.test(schoolId || keepId)) throw new Error(`${schoolId ? '--school' : '--all-except'} needs a school id (a uuid).`);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && allowHost !== host) {
    throw new Error(`Refusing to touch non-local database "${host}". Pass --allow-host ${host} if this is the database you mean.`);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    let targets;
    if (schoolId) {
      const plan = await planSchoolDeletion(client, schoolId);
      if (!plan.school) {
        if (plan.total === 0) {
          console.log(`Nothing to delete: there is no school ${schoolId}, and no row in any table refers to it.`);
          return;
        }
        for (const s of plan.steps) if (s.rows) console.log(`  ${String(s.rows).padStart(7)}  ${s.table}`);
        throw new Error(`There is no school ${schoolId}, but the rows above still refer to it. This script will not act without the school row; investigate by hand.`);
      }
      if (execute && confirm !== plan.school.slug) {
        throw new Error(`Nothing was changed. --execute also needs --confirm ${plan.school.slug} (the school's slug), so the school being deleted is named twice.`);
      }
      targets = [plan.school];
    } else {
      const { keep, targets: rest } = await schoolsExcept(client, keepId);
      console.log(`Keeping: ${keep.name} (${keep.slug}, ${keep.id})`);
      console.log(`Deleting every other school: ${rest.length}`);
      if (execute && confirm !== keep.slug) {
        throw new Error(`Nothing was changed. --execute also needs --confirm ${keep.slug} (the slug of the school being KEPT), so it is named twice.`);
      }
      if (execute && confirmCount !== String(rest.length)) {
        throw new Error(`Nothing was changed. --execute also needs --confirm-count ${rest.length}, the number of schools this run deletes, as the dry run printed it.`);
      }
      targets = rest;
    }
    if (execute && !operatorEmail) {
      throw new Error('Nothing was changed. --execute needs --operator <email>: the Chronix super admin running it, named on the purge record.');
    }
    if (execute && withSupabase === skipSupabase) {
      throw new Error('Nothing was changed. --execute needs exactly one of --with-supabase (delete the Auth accounts and stored files too) or --skip-supabase (list them for you to delete).');
    }
    if (execute && withSupabase && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
      throw new Error('Nothing was changed. --with-supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.');
    }
    const operatorId = execute ? await resolveOperator(client, operatorEmail) : null;

    console.log(`Database ${host}. ${execute ? 'EXECUTING:' : 'DRY RUN — nothing will be changed:'}`);
    const contacts = { emails: new Set(), phones: new Set() };
    for (const t of targets) {
      const plan = await planSchoolDeletion(client, t.id);
      printPlan(plan);
      for (const e of plan.emails) contacts.emails.add(e);
      for (const p of plan.phones) contacts.phones.add(p);
    }
    printContacts({ emails: [...contacts.emails].sort(), phones: [...contacts.phones].sort() });
    console.log(`Before deleting, --execute suspends ${targets.length === 1 ? 'the school' : `all ${targets.length} schools`} and waits ${deletionWaitSeconds()} s.`);
    if (!execute) return;

    let admin = null;
    if (withSupabase) {
      const { createClient } = require('@supabase/supabase-js');
      admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    }
    await deleteSchools(client, targets, {
      operatorId,
      beforeDatabase: (id) => supabaseStep(client, admin, id),
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    });
    if (keepId) {
      await assertOnlySchoolLeft(client, keepId);
      console.log(`Checked: exactly one school is left, and it is ${keepId}.`);
    }
    console.log('Done. Each school was checked inside its own transaction: 0 rows in every table.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = {
  STEPS, NOT_DELETED, planSchoolDeletion, executeSchoolDeletion, resolveOperator, storagePrefixes, deleteAuthAccounts,
  describeAuthAccounts, deletionWaitSeconds, WAIT_MARGIN_SECONDS, suspendSchools, schoolsExcept, assertOnlySchoolLeft,
  deleteSchools,
};
