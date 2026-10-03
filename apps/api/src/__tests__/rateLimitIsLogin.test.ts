import { isLogin } from '../middleware/rateLimit';

/**
 * rl:login counts failures of both sign-in steps (2FA commit 3): the password and, for a platform
 * admin with two-factor on, the code. A wrong code is a failed attempt like a wrong password; without
 * this the code step would fall under rl:auth's limit instead.
 */
describe('isLogin: which requests rl:login counts', () => {
  it('both sign-in steps, with or without a trailing slash', () => {
    for (const path of ['/login', '/login/', '/login/verify', '/login/verify/']) {
      expect({ path, counted: isLogin({ method: 'POST', path }) }).toEqual({ path, counted: true });
    }
  });

  it('nothing else: other auth routes, other methods, look-alike paths (the control)', () => {
    const others: Array<[string, string]> = [
      ['POST', '/forgot-password'], ['POST', '/confirm-reset'], ['POST', '/change-password'],
      ['GET', '/login'], ['GET', '/login/verify'], ['POST', '/login/verifyx'], ['POST', '/loginx'], ['POST', '/login/verify/extra'],
    ];
    for (const [method, path] of others) {
      expect({ method, path, counted: isLogin({ method, path }) }).toEqual({ method, path, counted: false });
    }
  });
});
