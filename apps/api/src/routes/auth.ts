import express from 'express';
import { supabase, supabaseAdmin } from '../supabaseClient';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { verifyToken, requireRole } from '../middleware/auth';

const router = express.Router();

function getPgClient() {
  const conn = process.env.DATABASE_URL || '';
  return new Client({ connectionString: conn });
}

router.post('/create-user', verifyToken, requireRole('super_admin'), async (req, res) => {
  const { email, password, role, school_id, first_name, last_name, title, teacher_mode } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'Missing fields' });

  try {
    // create user in Supabase Auth using service role
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      user_metadata: { first_name, last_name, role, school_id, title, teacher_mode }
    } as any);
    if (error) return res.status(500).json({ error: error.message });

    const userId = data?.user?.id ?? null;

    // insert into local users table
    const pg = getPgClient();
    await pg.connect();
    const hashed = bcrypt.hashSync(password, 10);
    await pg.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, teacher_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, school_id || null, email, hashed, role, first_name || '', last_name || '', title || null, teacher_mode || 'subject']
    );
    await pg.end();

    return res.json({ success: true, userId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password } as any);
    if (error) return res.status(401).json({ error: error.message });

    const userId = data?.user?.id || null;

    // fetch local user record
    const pg = getPgClient();
    await pg.connect();
    const r = await pg.query('SELECT id, school_id, role, title, email FROM users WHERE email = $1', [email]);
    await pg.end();
    const local = r.rows[0];
    if (!local) return res.status(500).json({ error: 'Local user record missing' });

    const payload = {
      user_id: userId || local.id,
      school_id: local.school_id,
      role: local.role,
      email: local.email,
      title: local.title
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || '', { expiresIn: '1h' });
    return res.json({ access_token: token, user: payload });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  const { email, redirect_to } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirect_to });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
