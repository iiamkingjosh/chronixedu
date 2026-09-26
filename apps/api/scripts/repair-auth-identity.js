/**
 * Repairs one user whose local `users` row has no Supabase Auth identity.
 *
 * Login is supabase.auth.signInWithPassword, and the local row is then resolved BY
 * THE AUTH ID that call returns (SECURITY.md Round 11 H-01). A users row whose id is
 * not a real auth id can never be logged into, whatever its password_hash says.
 *
 * This creates the missing identity AT the id the local row already uses, so no local
 * id is ever mutated and no dependent row (students, scores, attendance, parent links)
 * is touched. Supabase's admin API honours an explicit id — verified against a
 * throwaway address before use, and asserted again below.
 *
 * The password is GENERATED and printed once, never hardcoded. An earlier draft of
 * this file hardcoded the same constant the Round 11 M-01 fix had just removed, in a
 * publicly readable repo. Note also that a repaired account's stored password_hash
 * must never be reused to mint the auth password: accounts bulk-imported before
 * c39e937 hash a password that was public for months, so doing that would convert a
 * bug that BLOCKS login into working public credentials.
 *
 * Scope: deliberately single-account. A 2026-09-26 sweep found exactly one broken
 * account belonging to a real school; every other broken row is integration-test
 * residue. Do not generalise this without re-running that sweep.
 *
 * Run: node apps/api/scripts/repair-auth-identity.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(process.cwd(), 'apps/api/.env') });
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { randomBytes } = require('crypto');

const LOCAL_ID  = '793eb09a-212b-4c15-8716-5077e75ca88c'; // Daniel Jude's existing users.id
const ORPHAN_ID = '75bfbd5e-e909-4c23-bb5e-661d6cd10012'; // auth row nothing points at
const EMAIL     = 'student2@gmail.com';
const SCHOOL_ID = 'f1347b5c-584f-43e5-ba05-6770139c6c8f';

// Generated per run and printed once at the end. Override only for a deliberate
// re-run where the operator already told the user a password.
const PASSWORD = process.env.REPAIR_PASSWORD || randomBytes(9).toString('base64url');

/** Mirrors src/db/client.ts: TLS is decided here, not by the connection string. */
function resolveSsl(url) {
  const host = new URL(url).hostname;
  if (['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) return undefined;
  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) {
    if (!fs.existsSync(caPath)) throw new Error(`PGSSLROOTCERT points at a missing file: ${caPath}`);
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  console.warn('WARNING: encrypted but unverified — Supabase\'s pooler cert chains to a private root. Set PGSSLROOTCERT for a verified connection.');
  return { rejectUnauthorized: false };
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(process.env.DATABASE_URL),
  });
  await db.connect();

  // ── Guards. Any failure aborts before a single write. ───────────────────────
  const u = await db.query(
    `SELECT id, email, role, first_name, last_name FROM users WHERE id = $1`, [LOCAL_ID]);
  if (u.rows.length !== 1) throw new Error('local users row not found — aborting');
  if (u.rows[0].email.toLowerCase() !== EMAIL) throw new Error('local row is not ' + EMAIL + ' — aborting');

  const { data: already } = await sb.auth.admin.getUserById(LOCAL_ID);
  if (already && already.user) throw new Error('an auth identity already exists at the local id — nothing to repair');

  const pointsAtOrphan = await db.query(`SELECT 1 FROM users WHERE id = $1`, [ORPHAN_ID]);
  if (pointsAtOrphan.rows.length > 0) throw new Error('a users row points at the orphan id — aborting');

  // The audit row records the operator as the actor, not the repaired account.
  // audit_logs.user_id is a FK to users(id), and ROOT_ADMIN_EMAIL is a platform
  // identity with no users row of its own, so the actor must be named explicitly —
  // normally the principal of the school being repaired.
  const actorEmail = process.env.REPAIR_ACTOR_EMAIL || process.env.ROOT_ADMIN_EMAIL;
  if (!actorEmail) throw new Error('set REPAIR_ACTOR_EMAIL to the admin running this — it attributes the audit row');
  const actor = await db.query(
    `SELECT id, role FROM users WHERE lower(email) = lower($1) AND school_id = $2`, [actorEmail, SCHOOL_ID]);
  if (actor.rows.length !== 1) {
    throw new Error(`no users row in this school for "${actorEmail}" — set REPAIR_ACTOR_EMAIL to an admin of the school being repaired`);
  }
  if (!['principal', 'super_admin'].includes(actor.rows[0].role)) {
    throw new Error(`REPAIR_ACTOR_EMAIL "${actorEmail}" is a ${actor.rows[0].role}; this repair should be attributed to a principal or super_admin`);
  }
  const ACTOR_ID = actor.rows[0].id;

  // ── 1. Free the email by removing the unreferenced auth row. ────────────────
  const { data: orphan } = await sb.auth.admin.getUserById(ORPHAN_ID);
  if (orphan && orphan.user) {
    if ((orphan.user.email || '').toLowerCase() !== EMAIL) throw new Error('orphan id is not this email — aborting');
    const { error } = await sb.auth.admin.deleteUser(ORPHAN_ID);
    if (error) throw new Error('orphan delete failed: ' + error.message);
    console.log('1/4 deleted orphan auth row', ORPHAN_ID);
  } else {
    console.log('1/4 no orphan auth row to delete');
  }

  // ── 2. Create the identity at the id the local row already uses. ────────────
  const { data, error } = await sb.auth.admin.createUser({
    id: LOCAL_ID,
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      first_name: u.rows[0].first_name,
      last_name: u.rows[0].last_name,
      role: 'student',
      school_id: SCHOOL_ID,
    },
  });
  if (error) throw new Error('createUser failed: ' + error.message);
  if (data.user.id !== LOCAL_ID) throw new Error('Supabase returned a different id: ' + data.user.id);
  console.log('2/4 created auth identity at', data.user.id);

  // ── 3. password_hash is what the change-password route verifies against. ────
  await db.query(
    `UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2`,
    [bcrypt.hashSync(PASSWORD, 12), LOCAL_ID]);
  console.log('3/4 local password_hash aligned, must_change_password set');

  // ── 4. Doctrine 6: every sensitive write is audited. ────────────────────────
  await db.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, new_value)
     VALUES ($1, $2, 'USER_AUTH_IDENTITY_REPAIRED', 'user', $3, $4)`,
    [SCHOOL_ID, ACTOR_ID, LOCAL_ID, JSON.stringify({
      reason: 'registered without a Supabase Auth identity (SECURITY.md Round 11 H-01)',
      orphan_auth_id_deleted: ORPHAN_ID,
      email: EMAIL,
      password_rotated: true,
    })]);
  console.log('4/4 audit row written, attributed to', actorEmail);

  console.log('\n──────────────────────────────────────────────');
  console.log(' Temporary password for ' + EMAIL + ':');
  console.log('   ' + PASSWORD);
  console.log(' Shown once. Hand it over privately; the account');
  console.log(' must change it at first login.');
  console.log('──────────────────────────────────────────────');

  await db.end();
})().catch(e => { console.error('ABORTED:', e.message); process.exit(1); });
