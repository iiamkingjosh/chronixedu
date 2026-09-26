/**
 * Repairs one user whose local `users` row has no Supabase Auth identity.
 *
 * Login is supabase.auth.signInWithPassword, and the local row is then resolved BY
 * THE AUTH ID that call returns (SECURITY.md Round 11 H-01). A users row whose id is
 * not a real auth id can never be logged into, whatever its password_hash says.
 *
 * This creates the missing identity AT the id the local row already uses, so no local
 * id is ever mutated and no dependent row (students, scores, attendance, parent links)
 * is touched. Supabase's admin API honours an explicit id — verified before use, and
 * asserted again below.
 *
 * Run: node apps/api/scripts/repair-auth-identity.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), 'apps/api/.env') });
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const LOCAL_ID  = '793eb09a-212b-4c15-8716-5077e75ca88c'; // Daniel Jude's existing users.id
const ORPHAN_ID = '75bfbd5e-e909-4c23-bb5e-661d6cd10012'; // auth row nothing points at
const EMAIL     = 'student2@gmail.com';
const SCHOOL_ID = 'f1347b5c-584f-43e5-ba05-6770139c6c8f';
const PASSWORD  = 'Password2$';

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcrypt.hashSync(PASSWORD, 12), LOCAL_ID]);
  console.log('3/4 local password_hash aligned');

  // ── 4. Doctrine 6: every sensitive write is audited. ────────────────────────
  await db.query(
    `INSERT INTO audit_logs (school_id, user_id, action_type, entity, entity_id, new_value)
     VALUES ($1, $2, 'USER_AUTH_IDENTITY_REPAIRED', 'user', $3, $4)`,
    [SCHOOL_ID, LOCAL_ID, LOCAL_ID, JSON.stringify({
      reason: 'registered without a Supabase Auth identity (SECURITY.md Round 11 H-01)',
      orphan_auth_id_deleted: ORPHAN_ID,
      email: EMAIL,
    })]);
  console.log('4/4 audit row written');

  await db.end();
})().catch(e => { console.error('ABORTED:', e.message); process.exit(1); });
