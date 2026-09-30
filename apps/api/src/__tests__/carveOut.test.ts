/**
 * The read-only carve-out, tested for the property that matters: a route that lets a school
 * pay Chronix cannot exist under /api/schools WITHOUT being carved out.
 *
 * The first version of this check (trialGate.db.test.ts) asserted the allowlist was empty.
 * That was true, and would stay true forever, and proved nothing: the day the payment system
 * shipped a checkout route, read-only would block it, and a lapsed school could not pay to
 * restore its own access — a mechanism that bites once, at the worst moment (doctrine 16).
 *
 * So this walks the routers index.ts actually mounts on /api/schools after the read-only
 * guard, reads every write route they declare, and requires each one whose path marks it as
 * a platform payment (PLATFORM_PAYMENT_PATH — the naming contract) to be admitted by the
 * guard's own matcher. Two controls keep it honest: it must find the real write routes (a
 * walker that finds none passes vacuously), and a synthetic uncarved checkout must be caught.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { PLATFORM_PAYMENT_PATH, READ_ONLY_WRITE_ALLOWLIST, isAllowedWhileReadOnly } from '../middleware/requireWritableSubscription';

// The routers import the Supabase clients, which refuse to load without credentials. Nothing
// here calls them; the routes are only read, never exercised.
jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: {} }));

const SRC = path.join(__dirname, '..');
const SAMPLE_SCHOOL = '11111111-1111-4111-8111-111111111111';

interface WriteRoute { file: string; method: string; path: string }

/** Router modules mounted on /api/schools after requireWritableSubscription, per index.ts. */
function mountedSchoolRouters(): Array<{ name: string; file: string }> {
  const src = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  const imports = new Map<string, string>();
  for (const m of src.matchAll(/^import (\w+) from '\.\/(routes\/\w+)';\r?$/gm)) imports.set(m[1], m[2]);
  const GUARD = "app.use('/api/schools', requireWritableSubscription)";
  const guardAt = src.indexOf(GUARD);
  expect(guardAt).toBeGreaterThan(-1);
  const mounted = [...src.slice(guardAt + GUARD.length).matchAll(/app\.use\('\/api\/schools', (\w+)\)/g)].map(m => m[1]);
  const routers = mounted.map(name => ({ name, file: imports.get(name) }));
  expect(routers.filter(r => !r.file)).toEqual([]); // every mounted router resolved to its file
  return routers as Array<{ name: string; file: string }>;
}

function writeRoutesOf(router: express.Router, file: string): WriteRoute[] {
  const out: WriteRoute[] = [];
  for (const layer of (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on && !['get', 'head', 'options'].includes(method)) out.push({ file, method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

/** The path the guard sees for a route, with params filled in. */
const concrete = (routePath: string) => routePath.replace(/:schoolId/g, SAMPLE_SCHOOL).replace(/:\w+/g, SAMPLE_SCHOOL);

function uncarvedPaymentRoutes(routes: WriteRoute[]): WriteRoute[] {
  return routes.filter(r => PLATFORM_PAYMENT_PATH.test(r.path) && !isAllowedWhileReadOnly(r.method, concrete(r.path)));
}

describe('a platform payment route cannot exist outside the read-only carve-out', () => {
  // Loaded lazily: route modules construct pools and clients at import, which is fine here
  // (nothing connects) but should not happen at collection for every other test.
  let routes: WriteRoute[] = [];
  beforeAll(() => {
    for (const { file } of mountedSchoolRouters()) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(path.join(SRC, file));
      routes = routes.concat(writeRoutesOf(mod.default as express.Router, file));
    }
  });

  it('control: the walker finds the real write routes (a walker that finds none passes vacuously)', () => {
    expect(mountedSchoolRouters().length).toBeGreaterThanOrEqual(20);
    expect(routes.length).toBeGreaterThanOrEqual(60);
    expect(routes).toContainEqual({ file: 'routes/notices', method: 'POST', path: '/:schoolId/notices' });
  });

  it('control: an uncarved checkout route IS caught', () => {
    const fake = express.Router();
    fake.post('/:schoolId/platform-billing/checkout', (_req, res) => { res.end(); });
    expect(uncarvedPaymentRoutes(writeRoutesOf(fake, 'routes/fake'))).toHaveLength(1);
  });

  it('control: the same route, carved out, is not', () => {
    const fake = express.Router();
    fake.post('/:schoolId/platform-billing/checkout', (_req, res) => { res.end(); });
    READ_ONLY_WRITE_ALLOWLIST.push({ method: 'POST', path: /^\/[0-9a-f-]{36}\/platform-billing\/checkout$/, why: 'test' });
    try {
      expect(uncarvedPaymentRoutes(writeRoutesOf(fake, 'routes/fake'))).toEqual([]);
    } finally {
      READ_ONLY_WRITE_ALLOWLIST.length = 0;
    }
  });

  it('every write route mounted under /api/schools that is a platform payment is carved out', () => {
    expect(uncarvedPaymentRoutes(routes)).toEqual([]);
  });

  it('the naming contract does not accidentally claim an existing route (e.g. parent fee payments)', () => {
    // Parent → school fee payments are the school's income, deliberately OFF while read-only
    // (online_payments is one of the plan's extras). They must not match the platform
    // pattern, or carving them out would reopen them.
    expect(routes.filter(r => PLATFORM_PAYMENT_PATH.test(r.path))).toEqual([]);
    expect(PLATFORM_PAYMENT_PATH.test('/:schoolId/payments/paystack/initiate')).toBe(false);
  });
});
