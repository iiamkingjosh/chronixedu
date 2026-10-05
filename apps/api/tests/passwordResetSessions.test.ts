import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

/**
 * The premise behind confirm-reset's session step, measured against a real Supabase Auth (5 Oct 2026,
 * CHRONIXEDU-API-5): setting a password through the admin API ends EVERY Supabase session of the
 * account, the reset link's own included. So the route's global sign-out finds its session gone, and
 * treats that as done instead of alarming.
 *
 * If Supabase ever stops ending them, this fails. Without it, the route would quietly lose the one
 * alarm that would then be true. It needs a usable Supabase Auth: CI starts Supabase's local stack and
 * sets REQUIRE_TEST_AUTH; a local run skips it, with the reason printed by jest.globalSetup.ts.
 */
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import pool from '../src/db/client';
import authRoutes from '../src/routes/auth';
import { errorHandler } from '../src/middleware/errorHandler';
import { supabaseAdmin } from '../src/supabaseClient';
import { logger } from '../src/config/logger';

const itLiveAuth = process.env.TEST_AUTH_UNAVAILABLE ? it.skip : it;
const SCHOOL_ID = 'a8f70089-aef1-4f65-a226-4c68d0380285'; // the integration fixture's school

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRoutes);
  a.use(errorHandler);
  return a;
}

/** A browser of its own: one client, one session, nothing shared with the API's clients. */
const browser = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

describe('a password reset ends every Supabase session of the account', () => {
  const email = `reset-sessions-${randomUUID()}@chronix.test`;
  let authId: string | null = null;

  afterAll(async () => {
    if (authId) {
      await supabaseAdmin.auth.admin.deleteUser(authId);
      // The reset's audit row keeps the users row (audit_logs is append-only): guarded, as everywhere.
      await pool.query(`DELETE FROM users WHERE id = $1 AND id NOT IN (SELECT user_id FROM audit_logs WHERE user_id IS NOT NULL)`, [authId]);
    }
    await pool.end();
  });

  itLiveAuth("two signed-in sessions and the link's own are all gone after the reset, and nothing alarms", async () => {
    const created = await supabaseAdmin.auth.admin.createUser({ email, password: 'first-Password-123', email_confirm: true });
    expect(created.error).toBeNull();
    authId = created.data.user!.id;
    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ($1, $2, $3, $4, 'teacher', 'Reset', 'Sessions', true, 'subject', false)`,
      [authId, SCHOOL_ID, email, bcrypt.hashSync('first-Password-123', 4)]
    );

    // Two ordinary sessions, as on a phone and a laptop, and the reset link's own, as the email opens it.
    const phone = await browser().auth.signInWithPassword({ email, password: 'first-Password-123' });
    const laptop = await browser().auth.signInWithPassword({ email, password: 'first-Password-123' });
    const link = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email });
    expect([phone.error, laptop.error, link.error]).toEqual([null, null, null]);
    const opened = await browser().auth.verifyOtp({ type: 'recovery', token_hash: link.data.properties!.hashed_token });
    expect(opened.error).toBeNull();

    // The control: before the reset, all three can be refreshed (doctrine 16). Each refresh rotates the
    // token, so the newest of each is what is tried afterwards.
    const before = await Promise.all([phone, laptop, opened].map(s =>
      browser().auth.refreshSession({ refresh_token: s.data.session!.refresh_token })));
    expect(before.map(r => r.error)).toEqual([null, null, null]);

    const info = jest.spyOn(logger, 'info');
    const error = jest.spyOn(logger, 'error');
    const res = await request(app()).post('/api/auth/confirm-reset').send({
      password: 'second-Password-456', confirm_password: 'second-Password-456', access_token: opened.data.session!.access_token,
    });
    expect(res.status).toBe(200);

    const after = await Promise.all(before.map(r =>
      browser().auth.refreshSession({ refresh_token: r.data.session!.refresh_token })));
    expect(after.map(r => r.error !== null)).toEqual([true, true, true]);

    expect(info).toHaveBeenCalledWith('password_reset_sessions_already_ended', { user_id: authId });
    expect(error).not.toHaveBeenCalledWith('password_reset_sessions_not_revoked', expect.anything());
    // And the reset did what it was for.
    expect((await browser().auth.signInWithPassword({ email, password: 'second-Password-456' })).error).toBeNull();
    info.mockRestore();
    error.mockRestore();
  }, 30000);
});
