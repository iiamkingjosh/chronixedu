const createClient = jest.fn((..._args: unknown[]) => ({}));
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => createClient(...args) }));

/**
 * Neither Supabase client keeps a session (SECURITY.md Round 35). With supabase-js's server defaults,
 * the shared client held the last session signed in with and refreshed it for ever.
 */
describe('the API\'s Supabase clients', () => {
  it('are both created keeping no session and refreshing nothing', () => {
    process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
    process.env.SUPABASE_PUBLISHABLE_KEY ||= 'test';
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
    jest.isolateModules(() => { require('../supabaseClient'); });
    // The control: both clients were made through createClient, so the next line inspects them.
    expect(createClient).toHaveBeenCalledTimes(2);
    for (const call of createClient.mock.calls) {
      expect(call[2]).toEqual({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    }
  });
});
