/**
 * Reads every route index.ts mounts, without running any of them. Shared by twoFactorSetupRoutes.test.ts and
 * capabilityRoutes.test.ts, so both judge the same walk.
 *
 * The routers import the Supabase clients, which refuse to load without credentials: a test that loads routes
 * mocks '../supabaseClient' itself (jest.mock is hoisted per test file).
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { verifyToken } from '../../middleware/auth';

export const SRC = path.join(__dirname, '..', '..');

export interface Mount { prefix: string; name: string; file: string; behindAppVerify: boolean }
export interface RouteInfo {
  file: string; method: string; prefix: string; path: string; regexp: RegExp; behindVerify: boolean;
  /** Every handler on the route, in order: guards included. */
  handles: unknown[];
}

/** Every router index.ts mounts, in order, and whether an app-level verifyToken runs before it. */
export function mounts(): Mount[] {
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

export function routesOf(router: express.Router, mount: Mount): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    // A router-level use() or a nested router would hide routes or guards from this walk. None
    // exists today; if one is added, this fails and the walker must learn it first.
    expect({ file: mount.file, routerLevelLayer: !layer.route }).toEqual({ file: mount.file, routerLevelLayer: false });
    const route = layer.route!;
    expect({ file: mount.file, path: route.path, isString: typeof route.path === 'string' }).toMatchObject({ isString: true });
    const handles = route.stack.map(l => l.handle);
    const ownVerify = handles.includes(verifyToken);
    for (const [method, on] of Object.entries(route.methods)) {
      if (!on) continue;
      out.push({
        file: mount.file, method: method.toUpperCase(), prefix: mount.prefix, path: route.path as string,
        regexp: layer.regexp, behindVerify: mount.behindAppVerify || ownVerify, handles,
      });
    }
  }
  return out;
}

/** Every route of every mounted router. */
export function loadRoutes(): RouteInfo[] {
  // routes/superAdmin.ts refuses to load without it. Nothing here compares against it.
  process.env.ROOT_ADMIN_EMAIL ??= 'root@walk.invalid';
  let routes: RouteInfo[] = [];
  for (const mount of mounts()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(SRC, mount.file));
    routes = routes.concat(routesOf(mod.default as express.Router, mount));
  }
  return routes;
}

export const fullPattern = (r: RouteInfo) => `${r.method} ${r.prefix}${r.path}`;
