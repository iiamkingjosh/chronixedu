import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { createClient } from '@supabase/supabase-js';
import pool from '../db/client';

const SUPER_ADMIN_EMAIL = 'moses@chronixtech.com';

async function main() {
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [SUPER_ADMIN_EMAIL]);
  if (existing.rows[0]) {
    console.log('Super admin already exists');
    return;
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: SUPER_ADMIN_EMAIL,
    password: process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe@2026!',
    email_confirm: true,
  });
  if (error || !data?.user) {
    throw new Error(error?.message || 'Failed to create Supabase auth user');
  }

  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, teacher_mode, phone, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [data.user.id, null, SUPER_ADMIN_EMAIL, '', 'super_admin', 'Moses', 'Joshua', null, 'subject', null, true]
  );

  console.log('Super admin seeded successfully — moses@chronixtech.com');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
