/**
 * The two-factor setup carve-out, tested for the property that matters (reviewer, 4 Oct 2026): a
 * platform admin who must switch two-factor on, and has not, reaches exactly the routes in
 * TWO_FACTOR_SETUP_ROUTES and nothing else behind verifyToken.
 *
 * Same shape as carveOut.test.ts. This walks every router index.ts mounts, works out which routes
 * run verifyToken (the /api/schools mount, or the route's own stack), and asks verifyToken's own
 * matcher about each one. Both directions are checked: the admitted set must EQUAL the allowlist, so
 * a matcher that admits too much fails, and so does one that admits nothing. A second check makes
 * sure no other route behind verifyToken could answer an allowlisted address, because the matcher
 * judges the address, not the handler. Controls show each check failing on a broken input.
 *
 * Routes are read, never run. The runtime half (the middleware calls this matcher with the full
 * path) is adminTwoFactorRequired.db.test.ts.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { verifyToken, TWO_FACTOR_SETUP_ROUTES, isTwoFactorSetupRoute } from '../middleware/auth';

// The routers import the Supabase clients, which refuse to load without credentials. Nothing here
// calls them.
jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: {} }));

const SRC = path.join(__dirname, '..');
const SAMPLE = '11111111-1111-4111-8111-111111111111';

interface Mount { prefix: string; name: string; file: string; behindAppVerify: boolean }
interface RouteInfo { file: string; method: string; prefix: string; path: string; regexp: RegExp; behindVerify: boolean }
type Matcher = (method: string, fullPath: string) => boolean;

/** Every router index.ts mounts, in order, and whether an app-level verifyToken runs before it. */
function mounts(): Mount[] {
  const src = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  const imports = new Map<string, string>();
  for (const m of src.matchAll(/^import (\w+) from '\.\/(routes\/\w+)';\r?$/gm)) imports.set(m[1], m[2]);
  const verified: string[] = [];
  const out: Mount[] = [];
  for (const m of src.matchAll(/^app\.use\('([^']+)', (\w+)\);/gm)) {
    const [, prefix, name] = m;
    if (name === 'verifyToken') { verified.push(prefix); continue; }
    const file = imports.get(name);
    if (!file) continue; // other app-level middleware (detectSupportSession, requireActiveSchool, ...)
    out.push({ prefix, name, file, behindAppVerify: verified.some(v => prefix === v || prefix.startsWith(v + '/')) });
  }
  // Every imported router is mounted, so the walk below sees all of them.
  expect([...imports.keys()].filter(name => !out.some(o => o.name === name))).toEqual([]);
  return out;
}

type Layer = {
  route?: { path: unknown; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle: unknown;
  regexp: RegExp;
};

function routesOf(router: express.Router, mount: Mount): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    // A router-level use() or a nested router would hide routes or guards from this walk. None
    // exists today; if one is added, this fails and the walker must learn it first.
    expect({ file: mount.file, routerLevelLayer: !layer.route }).toEqual({ file: mount.file, routerLevelLayer: false });
    const route = layer.route!;
    expect({ file: mount.file, path: route.path, isString: typeof route.path === 'string' }).toMatchObject({ isString: true });
    const ownVerify = route.stack.some(l => l.handle === verifyToken);
    for (const [method, on] of Object.entries(route.methods)) {
      if (!on) continue;
      out.push({
        file: mount.file, method: method.toUpperCase(), prefix: mount.prefix, path: route.path as string,
        regexp: layer.regexp, behindVerify: mount.behindAppVerify || ownVerify,
      });
    }
  }
  return out;
}

const fullPattern = (r: RouteInfo) => `${r.method} ${r.prefix}${r.path}`;
const concrete = (r: RouteInfo) => `${r.prefix}${r.path.replace(/:\w+/g, SAMPLE)}`;

/** The routes a required-but-unenrolled admin's token gets through, by a given matcher. */
function admittedBy(routes: RouteInfo[], matcher: Matcher): string[] {
  return routes.filter(r => r.behindVerify && matcher(r.method, concrete(r))).map(fullPattern).sort();
}

/** Every route behind verifyToken that could answer this address, wherever it is mounted. */
function claimants(routes: RouteInfo[], method: string, address: string): string[] {
  return routes
    .filter(r => r.behindVerify && r.method === method && address.startsWith(r.prefix)
      && r.regexp.test(address.slice(r.prefix.length)))
    .map(fullPattern);
}

const ALLOWLIST = TWO_FACTOR_SETUP_ROUTES.map(r => `${r.method} ${r.path}`).sort();

describe('a platform admin who must set up two-factor reaches the setup routes and nothing else', () => {
  let routes: RouteInfo[] = [];
  beforeAll(() => {
    // routes/superAdmin.ts refuses to load without it. Nothing here compares against it.
    process.env.ROOT_ADMIN_EMAIL ??= 'root@walk.invalid';
    for (const mount of mounts()) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(path.join(SRC, mount.file));
      routes = routes.concat(routesOf(mod.default as express.Router, mount));
    }
  });

  it('control: the walker finds the real routes, and tells guarded from unguarded', () => {
    expect(routes.filter(r => r.behindVerify).length).toBeGreaterThanOrEqual(150);
    const find = (p: string) => routes.find(r => fullPattern(r) === p);
    expect(find('GET /api/super-admin/admins')?.behindVerify).toBe(true);
    expect(find('POST /api/auth/create-user')?.behindVerify).toBe(true);
    expect(find('POST /api/schools/:schoolId/notices')?.behindVerify).toBe(true);
    // Unguarded routes exist and are seen as unguarded: the sign-in steps and Paystack's webhook.
    expect(find('POST /api/auth/login')?.behindVerify).toBe(false);
    expect(find('POST /api/auth/login/verify')?.behindVerify).toBe(false);
    expect(find('POST /api/schools/platform-billing/webhook')?.behindVerify).toBe(false);
  });

  it('the matcher verifyToken uses admits exactly the allowlist: every entry is a real route, and nothing else', () => {
    expect(ALLOWLIST).toHaveLength(3);
    expect(admittedBy(routes, isTwoFactorSetupRoute)).toEqual(ALLOWLIST);
  });

  it('control: a matcher that admits one more route fails, and so does one that admits none', () => {
    const tooMuch: Matcher = (m, p) => isTwoFactorSetupRoute(m, p) || (m === 'GET' && p === '/api/super-admin/admins');
    expect(admittedBy(routes, tooMuch)).not.toEqual(ALLOWLIST);
    expect(admittedBy(routes, () => false)).not.toEqual(ALLOWLIST);
  });

  it('no other route behind verifyToken can answer an allowlisted address', () => {
    for (const entry of TWO_FACTOR_SETUP_ROUTES) {
      expect({ entry, claimants: claimants(routes, entry.method, entry.path) })
        .toEqual({ entry, claimants: [`${entry.method} ${entry.path}`] });
    }
  });

  it('control: a route that would answer an allowlisted address is caught', () => {
    const fake = express.Router();
    fake.get('/:section/status', verifyToken, (_req, res) => { res.end(); });
    const shadow = routesOf(fake, { prefix: '/api/super-admin', name: 'fake', file: 'routes/fake', behindAppVerify: false });
    expect(claimants([...routes, ...shadow], 'GET', '/api/super-admin/two-factor/status')).toHaveLength(2);
  });

  it('every platform-admin route runs verifyToken, so none is reachable around the check', () => {
    const platform = routes.filter(r => r.prefix.startsWith('/api/super-admin'));
    expect(platform.length).toBeGreaterThanOrEqual(40);
    expect(platform.filter(r => !r.behindVerify).map(fullPattern)).toEqual([]);
  });

  it('the matcher refuses near misses, so it fails closed', () => {
    expect(isTwoFactorSetupRoute('GET', '/api/super-admin/two-factor/status')).toBe(true);
    for (const [m, p] of [
      ['HEAD', '/api/super-admin/two-factor/status'],
      ['GET', '/api/super-admin/two-factor/status/'],
      ['GET', '/API/super-admin/two-factor/status'],
      ['POST', '/api/super-admin/two-factor/recovery-codes'],
      ['GET', '/api/super-admin/two-factor'],
    ]) {
      expect({ m, p, admitted: isTwoFactorSetupRoute(m, p) }).toEqual({ m, p, admitted: false });
    }
  });
});
