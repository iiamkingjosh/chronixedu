const signInWithPassword = jest.fn();
const adminSignOut = jest.fn();
const logError = jest.fn();

jest.mock('../supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: (...a: unknown[]) => signInWithPassword(...a) } },
  supabaseAdmin: { auth: { admin: { signOut: (...a: unknown[]) => adminSignOut(...a) } } },
}));
jest.mock('../config/logger', () => ({ logger: { error: (...a: unknown[]) => logError(...a), warn: jest.fn(), info: jest.fn() } }));

import { signInAndRevoke, passwordMatches } from '../services/passwordCheck';

const SESSION = { access_token: 'access-token-of-this-check', refresh_token: 'refresh-token-of-this-check' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('signInAndRevoke: the one way the API checks a password (Round 35)', () => {
  it('answers with the user id, and revokes the session the check created, and only that session', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: SESSION, user: { id: 'u1' } }, error: null });
    adminSignOut.mockResolvedValueOnce({ error: null });
    expect(await signInAndRevoke('a@b.test', 'right')).toBe('u1');
    expect(adminSignOut).toHaveBeenCalledTimes(1);
    expect(adminSignOut).toHaveBeenCalledWith('access-token-of-this-check', 'local');
  });

  it('answers null for a wrong password, and has nothing to revoke', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });
    expect(await signInAndRevoke('a@b.test', 'wrong')).toBeNull();
    expect(await passwordMatches('a@b.test', 'wrong')).toBe(false);
    expect(adminSignOut).not.toHaveBeenCalled();
  });

  it('still answers for a right password when revocation fails, and says so instead of swallowing it', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: SESSION, user: { id: 'u1' } }, error: null });
    adminSignOut.mockResolvedValueOnce({ error: { message: 'network down' } });
    expect(await signInAndRevoke('a@b.test', 'right')).toBe('u1');
    expect(logError).toHaveBeenCalledWith('password_check_session_not_revoked', { user_id: 'u1', error: 'network down' });
    // Neither token is ever logged.
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain('access-token-of-this-check');
    expect(logged).not.toContain('refresh-token-of-this-check');
  });

  it('passwordMatches is the same check, as a yes or no', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { session: SESSION, user: { id: 'u1' } }, error: null });
    adminSignOut.mockResolvedValueOnce({ error: null });
    expect(await passwordMatches('a@b.test', 'right')).toBe(true);
    expect(adminSignOut).toHaveBeenCalledWith('access-token-of-this-check', 'local');
  });
});
