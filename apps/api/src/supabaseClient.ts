import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set');
}

/**
 * Neither client keeps a session (SECURITY.md Round 35). On a server, supabase-js's defaults store
 * the last session signed in with in memory and refresh it for ever, so the shared client held
 * whoever had signed in most recently. The API never acts as a Supabase user: it checks a password
 * (services/passwordCheck.ts, which revokes the session that creates) and signs its own JWT.
 */
const SERVER_AUTH = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SERVER_AUTH);
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERVER_AUTH);

export default supabase;
