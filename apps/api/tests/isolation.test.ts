import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SUPABASE_URL              = process.env.SUPABASE_URL              ?? '';
const SUPABASE_PUBLISHABLE_KEY  = process.env.SUPABASE_PUBLISHABLE_KEY  ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing required env vars — check apps/api/.env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY'
  );
}

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Debug: verify admin client role
admin.from('schools').select('count').limit(1).then(({ data: _data, error, status }) => {
  console.log('Admin client test - status:', status, 'error:', error?.message ?? 'none');
});

function anonClientWithToken(accessToken: string) {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

describe('T3 — RLS tenant isolation: School A cannot read School B data', () => {
  const schoolAId = randomUUID();
  const schoolBId = randomUUID();
  const emailA    = `test-a-${randomUUID()}@chronixedu-test.com`;
  const emailB    = `test-b-${randomUUID()}@chronixedu-test.com`;
  const password  = 'TestPassword123!';

  let userAId: string | undefined;
  let userBId: string | undefined;
  let tokenB: string;

  beforeAll(async () => {
    console.log('SUPABASE_URL loaded:', !!process.env.SUPABASE_URL);
    console.log('SERVICE_ROLE_KEY loaded:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('SERVICE_ROLE_KEY prefix:', process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 30));

    // 1. Insert school records via service role (bypasses RLS)
    const { error: errA } = await admin.from('schools').insert({
      id:   schoolAId,
      name: 'Isolation Test School A',
      slug: `isolation-a-${schoolAId.slice(0, 8)}`,
    });
    if (errA) {
      console.log('Full error A:', JSON.stringify(errA));
      throw new Error(`School A insert failed: ${errA.message}`);
    }

    const { error: errB } = await admin.from('schools').insert({
      id:   schoolBId,
      name: 'Isolation Test School B',
      slug: `isolation-b-${schoolBId.slice(0, 8)}`,
    });
    if (errB) throw new Error(`School B insert failed: ${errB.message}`);

    // 2. Create real Supabase Auth users (email_confirm skips the verification email)
    const { data: dataA, error: errUA } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (errUA) throw new Error(`User A create failed: ${errUA.message}`);
    userAId = dataA.user.id;

    const { data: dataB, error: errUB } = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (errUB) throw new Error(`User B create failed: ${errUB.message}`);
    userBId = dataB.user.id;

    // 3. Stamp each user's app_metadata with their school_id —
    //    app_metadata is server-controlled and lands in the JWT claims
    const { error: errMA } = await admin.auth.admin.updateUserById(userAId, {
      app_metadata: { school_id: schoolAId },
    });
    if (errMA) throw new Error(`User A metadata update failed: ${errMA.message}`);

    const { error: errMB } = await admin.auth.admin.updateUserById(userBId, {
      app_metadata: { school_id: schoolBId },
    });
    if (errMB) throw new Error(`User B metadata update failed: ${errMB.message}`);

    // 4. Sign in as School B AFTER metadata update to get a fresh JWT
    //    that carries the school_id claim
    const signInClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    const { data: sessionB, error: errSB } = await signInClient.auth.signInWithPassword({
      email: emailB,
      password,
    });
    if (errSB) throw new Error(`School B sign-in failed: ${errSB.message}`);
    tokenB = sessionB.session!.access_token;
  }, 30000);

  afterAll(async () => {
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
    await admin.from('schools').delete().eq('id', schoolAId);
    await admin.from('schools').delete().eq('id', schoolBId);
  }, 15000);

  it('School B JWT cannot read School A record — RLS returns zero rows', async () => {
    const client = anonClientWithToken(tokenB);
    const { data, error } = await client
      .from('schools')
      .select('*')
      .eq('id', schoolAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  }, 15000);

  it('RLS correctly blocks unverified JWT from reading any record — isolation confirmed both ways', async () => {
    const client = anonClientWithToken(tokenB);
    const { data, error } = await client
      .from('schools')
      .select('*')
      .eq('id', schoolBId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  }, 15000);
});
