import fs from 'fs';
import path from 'path';
import { paletteEntriesForRole, filterPalette } from '../commandPalette';
import {
  getMainNavForRole, getNavGroupsForRole, settingsAccessForRole,
  SETTINGS_NAV, SUPER_ADMIN_NAV, SUPER_ADMIN_NAV_GROUPS,
  PRINCIPAL_NAV, TEACHER_NAV, REGISTRAR_NAV, BURSAR_NAV,
} from '../navigation';

/**
 * The property that matters: for each role, the palette offers EXACTLY the pages that role can
 * open — no more (a page the guard refuses is a 403 the palette caused) and no fewer. The
 * expected set is built independently from getMainNavForRole and the settings access rules the
 * sidebar uses, then compared by equality. "Non-empty" would pass on a palette that renders
 * nothing useful, so it is not the assertion.
 */
const ROLES = ['super_admin', 'principal', 'teacher', 'registrar', 'bursar', 'parent', 'student'];

function expectedHrefs(role: string): string[] {
  const own = getMainNavForRole(role).map((i) => i.href);
  const access = settingsAccessForRole(role);
  const settings = access === 'all' ? SETTINGS_NAV.map((i) => i.href) : access === 'payout' ? ['/settings/payout'] : [];
  return [...own, ...settings].sort();
}

describe('the palette offers exactly the pages each role can open', () => {
  it.each(ROLES)('%s', (role) => {
    const offered = paletteEntriesForRole(role).map((e) => e.href).sort();
    expect(offered).toEqual(expectedHrefs(role));
    expect(new Set(offered).size).toBe(offered.length); // and offers none twice
  });

  it('the comparison has teeth: the staff roles each expect pages, and they differ by role', () => {
    for (const role of ['principal', 'teacher', 'registrar', 'bursar']) expect(expectedHrefs(role).length).toBeGreaterThan(0);
    expect(expectedHrefs('teacher')).not.toContain('/settings/identity');
    expect(expectedHrefs('bursar')).toContain('/settings/payout');
    expect(expectedHrefs('bursar')).not.toContain('/settings/users');
  });
});

/**
 * The two areas are separate apps sharing a login: the platform-admin area (app/super-admin)
 * and the school dashboard. A palette in either must offer only its own area's pages. Both
 * expected sets are built from navigation.ts.
 */
describe('platform pages and school pages never cross', () => {
  const PLATFORM = new Set(SUPER_ADMIN_NAV.map((i) => i.href));
  const SCHOOL = new Set([...PRINCIPAL_NAV, ...TEACHER_NAV, ...REGISTRAR_NAV, ...BURSAR_NAV, ...SETTINGS_NAV].map((i) => i.href));

  it('the two sets are real and disjoint', () => {
    expect(PLATFORM.size).toBe(10);
    expect(SCHOOL.size).toBeGreaterThan(20);
    expect([...PLATFORM].filter((h) => SCHOOL.has(h))).toEqual([]);
  });

  it('the platform palette offers exactly the platform pages, and no school page', () => {
    const offered = paletteEntriesForRole('super_admin').map((e) => e.href);
    expect(new Set(offered)).toEqual(PLATFORM);
    expect(offered.filter((h) => SCHOOL.has(h))).toEqual([]);
  });

  it.each(['principal', 'teacher', 'registrar', 'bursar'])('the %s palette offers school pages only, never a platform page', (role) => {
    const offered = paletteEntriesForRole(role).map((e) => e.href);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((h) => PLATFORM.has(h))).toEqual([]);
    expect(offered.filter((h) => !SCHOOL.has(h))).toEqual([]);
  });

  it("the platform sidebar reads the same groups the palette does, and keeps no list of its own", () => {
    expect(getNavGroupsForRole('super_admin')).toBe(SUPER_ADMIN_NAV_GROUPS);
    const layout = fs.readFileSync(path.join(__dirname, '../../app/super-admin/layout.tsx'), 'utf8');
    expect(layout).toMatch(/getNavGroupsForRole\(/);
    expect(layout.match(/['"`]\/super-admin\/[a-z-]+/g) ?? []).toEqual([]); // no hard-coded platform paths
  });
});

describe('matching', () => {
  const principal = paletteEntriesForRole('principal');
  const hrefsFor = (q: string) => filterPalette(principal, q).map((e) => e.href);

  it('matches the description, not only the label', () => {
    expect(hrefsFor('export')).toContain('/settings/export');
    expect(hrefsFor('pass mark')).toEqual(expect.arrayContaining(['/settings/grading-scale', '/settings/level-grading']));
  });

  it('is case-insensitive, needs every word, and an empty query lists everything', () => {
    expect(hrefsFor('DATA EXPORT')).toEqual(['/settings/export']);
    expect(hrefsFor('pass mark zebra')).toEqual([]);
    expect(filterPalette(principal, '   ')).toHaveLength(principal.length);
  });

  it('carries the group label, so the same page name reads differently in different places', () => {
    expect(principal.find((e) => e.href === '/principal/attendance')?.group).toBe('Students');
    expect(paletteEntriesForRole('teacher').find((e) => e.href === '/teacher/attendance')?.group).toBe('Teaching');
    expect(principal.find((e) => e.href === '/settings/export')?.group).toBe('Settings · Setup');
  });
});
