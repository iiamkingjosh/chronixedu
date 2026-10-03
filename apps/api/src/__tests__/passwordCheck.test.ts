const signInWithPassword = jest.fn();
const createClient = jest.fn((..._args: unknown[]) => ({ auth: { signInWithPassword } }));
const adminSignOut = jest.fn();
const logError = jest.fn();

jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => createClient(...args) }));
jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: { auth: { admin: { signOut: (...a: unknown[]) => adminSignOut(...a) } } } }));
jest.mock('../config/logger', () => ({ logger: { error: (...a: unknown[]) => logError(...a), warn: jest.fn(), info: jest.fn() } }));

import { passwordMatches } from '../services/passwordCheck';

const SESSION = { access_token: 'access-token-of-this-check', refresh_token: 'refresh' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('passwordMatches', () => {
  it('checks through its own client, which keeps no session and refreshes nothing', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: SESSION, user: { id: 'u1' } }, error: null });
    adminSignOut.mockResolvedValueOnce({ error: null });
    expect(await passwordMatches('a@b.test', 'right')).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0][2]).toEqual({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  });

  it('revokes the session the check created, and only that session', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: SESSION, user: { id: 'u1' } }, error: null });
    adminSignOut.mockResolvedValueOnce({ error: null });
    await passwordMatches('a@b.test', 'right');
    expect(adminSignOut).toHaveBeenCalledWith('access-token-of-this-check', 'local');
  });

  it('answers false for a wrong password and has nothing to revoke', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });
    expect(await passwordMatches('a@b.test', 'wrong')).toBe(false);
    expect(adminSignOut).not.toHaveBeenCalled();
  });

  it('still answers true when revocation fails, and says so in the log instead of swallowing it', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: SESSION, user: { id: 'u1' } }, error: null });
    adminSignOut.mockResolvedValueOnce({ error: { message: 'network down' } });
    expect(await passwordMatches('a@b.test', 'right')).toBe(true);
    expect(logError).toHaveBeenCalledWith('password_check_session_not_revoked', { user_id: 'u1', error: 'network down' });
    // The token itself is never logged.
    expect(JSON.stringify(logError.mock.calls)).not.toContain('access-token-of-this-check');
  });
});
