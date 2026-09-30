#!/usr/bin/env node
'use strict';
/**
 * Delete one school's data — the deletion half of the promise in the Data Processing
 * Agreement and Terms §22 ("permanently delete … within 90 days" of termination).
 * Runbook: docs/data-deletion-runbook.md. Read it before running this against anything real.
 *
 *   node apps/api/scripts/delete-school-data.js --school <uuid>                  # dry run: prints the plan
 *   node apps/api/scripts/delete-school-data.js --school <uuid> --execute --confirm <school-slug> --with-supabase
 *   --allow-host <host>  required for a non-local database (must equal the DATABASE_URL host)
 *   --with-supabase      delete the users' Supabase Auth accounts and the school's Storage files
 *                        too, BEFORE the database step (needs SUPABASE_URL and
 *                        SUPABASE_SERVICE_ROLE_KEY; the key is never printed)
 *   --skip-supabase      leave them, and print what was left — the only time the Auth ids are
 *                        printed, since the users rows that list them are about to go
 *   --execute needs exactly one of the two, so leaving them behind is a choice, not an omission.
 *
 * WHAT IT CANNOT DELETE, BY DESIGN, UNTIL A DECISION IS MADE. audit_logs is append-only for
 * every caller (migrations 036/037: no DELETE, no content UPDATE) and holds foreign keys to
 * users and schools. So the school's audit rows stay, and with them the school's own row and
 * every user an audit row names. platform_audit_logs (Chronix's audit of its own admins) is
 * kept alongside for the same reason. The runbook sets out the choice — drop the trigger in
 * its own migration, or anonymise — and which one needs what. This script reports exactly
 * what is left and why, rather than deleting around the rule.
 *
 * Everything else goes in ONE transaction, children before parents, scoped to the school:
 * directly on school_id, or through the school's students, users, terms, sessions,
 * assignments or assessment configs for tables that have no school_id. email_queue has no
 * link to a school at all and is matched on the school's users' email addresses.
 */
const { Client } = require('pg');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

const S = `(SELECT id FROM students WHERE school_id = $1)`;
const U = `(SELECT id FROM users WHERE school_id = $1)`;
const T = `(SELECT id FROM terms WHERE school_id = $1)`;
const SES = `(SELECT id FROM academic_sessions WHERE school_id = $1)`;
const own = (table) => ({ table, where: `school_id = $1` });

/** Children before parents — the order the foreign keys require (see the runbook's map). */
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
  own('platform_subscriptions'),
  own('school_settings'),
  // Users no audit row names. An audited user is kept (see the header) — deleting them
  // would violate audit_logs' foreign key.
  { table: 'users', where: `school_id = $1
      AND id NOT IN (SELECT user_id FROM audit_logs WHERE user_id IS NOT NULL)
      AND id NOT IN (SELECT target_user_id FROM platform_audit_logs WHERE target_user_id IS NOT NULL)
      AND id NOT IN (SELECT platform_admin_id FROM platform_audit_logs)` },
];

/**
 * Every other table, and why this script leaves it alone. schoolDeletion.db.test.ts fails if a
 * table is in neither list — a new table holding school data must be added to STEPS (or
 * here, with a reason) before this script can be trusted again.
 */
const NOT_DELETED = {
  audit_logs: 'Append-only for every caller (migrations 036/037). Retained pending the [MOSES] (a)/(b) decision in the runbook.',
  platform_audit_logs: "Chronix's audit of its own admins' actions; kept with audit_logs under the same decision.",
  schools: 'Deleted last, and only when no audit row still references it (see executeSchoolDeletion).',
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

/** What would be deleted and what would remain, changing nothing. */
async function planSchoolDeletion(client, schoolId) {
  const school = (await client.query(`SELECT id, slug, name FROM schools WHERE id = $1`, [schoolId])).rows[0];
  if (!school) throw new Error(`No school with id ${schoolId}`);
  const steps = [];
  for (const s of STEPS) steps.push({ table: s.table, rows: await count(client, s.table, s.where, schoolId) });
  const authUserIds = (await client.query(`SELECT id FROM users WHERE school_id = $1 ORDER BY id`, [schoolId])).rows.map(r => r.id);
  const storageObjects = await listStorageObjects(client, schoolId);
  const deletableUsers = steps.find(s => s.table === 'users').rows;
  const retained = {
    audit_logs: await count(client, 'audit_logs', `school_id = $1 OR user_id IN ${U}`, schoolId),
    platform_audit_logs: await count(client, 'platform_audit_logs', `target_school_id = $1 OR target_user_id IN ${U}`, schoolId),
    users: authUserIds.length - deletableUsers,
    school_row: true,
  };
  return { school, steps, retained, authUserIds, storageObjects };
}

/**
 * Delete everything the plan lists, in one transaction. Returns the plan it executed and
 * whether the school's own row could go (only when nothing references it any more).
 */
async function executeSchoolDeletion(client, schoolId) {
  const plan = await planSchoolDeletion(client, schoolId);
  await client.query('BEGIN');
  try {
    for (const s of STEPS) {
      await client.query(`DELETE FROM ${s.table} WHERE ${s.where}`, [schoolId]);
    }
    const blocked = await count(client, 'audit_logs', `school_id = $1`, schoolId)
      + await count(client, 'platform_audit_logs', `target_school_id = $1`, schoolId)
      + await count(client, 'users', `school_id = $1`, schoolId);
    let schoolDeleted = false;
    if (blocked === 0) {
      await client.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
      schoolDeleted = true;
    }
    await client.query('COMMIT');
    return { ...plan, schoolDeleted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
  const schoolId = arg('--school');
  const execute = process.argv.includes('--execute');
  const confirm = arg('--confirm');
  const allowHost = arg('--allow-host');
  const withSupabase = process.argv.includes('--with-supabase');
  const skipSupabase = process.argv.includes('--skip-supabase');
  if (!schoolId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(schoolId)) {
    throw new Error('--school <uuid> is required');
  }

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
    if (execute && confirm !== plan.school.slug) {
      throw new Error(`Nothing was changed. --execute also needs --confirm ${plan.school.slug} (the school's slug), so the school being deleted is named twice.`);
    }
    if (execute && withSupabase === skipSupabase) {
      throw new Error('Nothing was changed. --execute needs exactly one of --with-supabase (delete the Auth accounts and stored files too) or --skip-supabase (list them for you to delete).');
    }
    if (execute && withSupabase && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
      throw new Error('Nothing was changed. --with-supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.');
    }
    const files = plan.storageObjects;
    console.log(`School: ${plan.school.name} (${plan.school.slug}) — database ${host}`);
    console.log(execute ? 'EXECUTING:' : 'DRY RUN — nothing will be changed:');
    for (const s of plan.steps) if (s.rows) console.log(`  delete ${String(s.rows).padStart(7)}  ${s.table}`);
    console.log('Kept (audit rule — see docs/data-deletion-runbook.md, "The decision"):');
    console.log(`  ${plan.retained.audit_logs} audit_logs row(s), ${plan.retained.platform_audit_logs} platform_audit_logs row(s), ${plan.retained.users} audited user(s), the school row`);
    console.log(`Supabase Auth accounts: ${plan.authUserIds.length}`);
    console.log(`Supabase Storage files: ${files === null ? 'not checked — this database has no storage schema' : files.length}`);
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

    const done = await executeSchoolDeletion(client, schoolId);
    console.log(`Committed. School row ${done.schoolDeleted ? 'deleted' : 'kept (still referenced)'}.`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { STEPS, NOT_DELETED, planSchoolDeletion, executeSchoolDeletion };
