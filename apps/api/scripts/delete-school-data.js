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
 *   --allow-host <host>  required for a non-local database (must equal the DATABASE_URL host)
 *   --operator <email>   the Chronix super admin running it; named on the purge record
 *                        (platform_audit_logs SCHOOL_AUDIT_PURGED). Required with --execute.
 *   --with-supabase      delete the users' Supabase Auth accounts and the school's Storage files
 *                        too, BEFORE the database step (needs SUPABASE_URL and
 *                        SUPABASE_SERVICE_ROLE_KEY; the key is never printed)
 *   --skip-supabase      leave them, and print what was left — the only time the Auth ids are
 *                        printed, since the users rows that list them are about to go
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
 * Where the API stores a school's files (grep ".upload(" under apps/api/src):
 *   school-assets (SUPABASE_STORAGE_BUCKET): schools/<id>/ — logo, signature, stamp, student
 *     photos, staff signatures, assignment attachments and submissions
 *   report-cards: <id>/ (report cards), receipts/<id>/, transcripts/<id>/
 * A new upload path outside these prefixes must be added here.
 */
function storagePrefixes(schoolId) {
  const assets = process.env.SUPABASE_STORAGE_BUCKET || 'school-assets';
  return [
    { bucket: assets, prefix: `schools/${schoolId}/` },
    { bucket: 'report-cards', prefix: `${schoolId}/` },
    { bucket: 'report-cards', prefix: `receipts/${schoolId}/` },
    { bucket: 'report-cards', prefix: `transcripts/${schoolId}/` },
  ];
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

/** What would be deleted, changing nothing. `school` is null once the school row is gone. */
async function planSchoolDeletion(client, schoolId) {
  const school = (await client.query(`SELECT id, slug, name FROM schools WHERE id = $1`, [schoolId])).rows[0] || null;
  const steps = await countAll(client, schoolId);
  const total = steps.reduce((a, s) => a + s.rows, 0);
  const authUserIds = (await client.query(`SELECT id FROM users WHERE school_id = $1 ORDER BY id`, [schoolId])).rows.map(r => r.id);
  const storageObjects = await listStorageObjects(client, schoolId);
  const contacts = await listContacts(client, schoolId);
  return { school, steps, total, authUserIds, storageObjects, ...contacts };
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
 * every table before it commits, and rolls back unless every count is zero.
 */
async function executeSchoolDeletion(client, schoolId, operatorId) {
  const plan = await planSchoolDeletion(client, schoolId);
  if (!plan.school) throw new Error(`No school with id ${schoolId}`);
  await client.query('BEGIN');
  try {
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

async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
  const schoolId = arg('--school');
  const execute = process.argv.includes('--execute');
  const confirm = arg('--confirm');
  const operatorEmail = arg('--operator');
  const allowHost = arg('--allow-host');
  const withSupabase = process.argv.includes('--with-supabase');
  const skipSupabase = process.argv.includes('--skip-supabase');
  if (!schoolId || !UUID.test(schoolId)) throw new Error('--school <uuid> is required');

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && allowHost !== host) {
    throw new Error(`Refusing to touch non-local database "${host}". Pass --allow-host ${host} if this is the database you mean.`);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
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

    const files = plan.storageObjects;
    console.log(`School: ${plan.school.name} (${plan.school.slug}) — database ${host}`);
    console.log(execute ? 'EXECUTING:' : 'DRY RUN — nothing will be changed:');
    for (const s of plan.steps) if (s.rows) console.log(`  delete ${String(s.rows).padStart(7)}  ${s.table}`);
    console.log(`Supabase Auth accounts: ${plan.authUserIds.length}`);
    console.log(`Supabase Storage files: ${files === null ? 'not checked — this database has no storage schema' : files.length}`);
    printContacts(plan);
    if (!execute) return;

    // Supabase goes FIRST. The Auth ids come from the users rows this run is about to
    // delete, so once the transaction commits a second run can no longer find them — an
    // account missed here would be an orphan holding an email address that nothing points
    // to. Deleting them first, and stopping if any fails, keeps the run repeatable.
    if (withSupabase) {
      const { createClient } = require('@supabase/supabase-js');
      const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      let failed = 0;
      for (const id of plan.authUserIds) {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error && !/not found/i.test(error.message)) { failed += 1; console.error(`  auth ${id}: ${error.message}`); }
      }
      if (failed) throw new Error(`${failed} Auth account(s) could not be deleted; the database was NOT touched. Fix and rerun — it is safe to repeat.`);
      console.log(`Auth accounts deleted (or already gone): ${plan.authUserIds.length}`);

      // Through the Storage API — deleting storage.objects rows directly would leave the files.
      for (const bucket of [...new Set((files || []).map(f => f.bucket))]) {
        const names = files.filter(f => f.bucket === bucket).map(f => f.name);
        for (let i = 0; i < names.length; i += 100) {
          const { error } = await admin.storage.from(bucket).remove(names.slice(i, i + 100));
          if (error) throw new Error(`Storage ${bucket}: ${error.message}; the database was NOT touched. Rerun — it is safe to repeat.`);
        }
      }
      const left = await listStorageObjects(client, schoolId);
      if (left && left.length) throw new Error(`${left.length} stored file(s) still present after removal; the database was NOT touched.`);
      console.log(`Stored files deleted: ${files === null ? 'n/a' : files.length}`);
    } else {
      console.log('--skip-supabase: NOT deleted, and after this run the database no longer lists the Auth accounts. Keep this list:');
      for (const id of plan.authUserIds) console.log(`  auth ${id}`);
      for (const f of files || []) console.log(`  file ${f.bucket}/${f.name}`);
    }

    await executeSchoolDeletion(client, schoolId, operatorId);
    console.log('Committed. Checked inside the same transaction: 0 rows for this school in every table.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { STEPS, NOT_DELETED, planSchoolDeletion, executeSchoolDeletion, resolveOperator, storagePrefixes };
