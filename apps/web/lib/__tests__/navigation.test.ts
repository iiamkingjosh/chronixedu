/// <reference types="jest" />
/**
 * The principal's sidebar: sixteen daily links in five groups, and thirteen settings links in
 * three, behind one entry. Pins the structure, and the one property a plain equality check
 * cannot see — "Report Cards" beside "Report Card" was a wrong-click generator and is not a
 * duplicate to `===`. Labels are compared lowercased with a trailing "s" removed, which is
 * what makes this test fail on the labels that motivated it.
 */
import {
  PRINCIPAL_NAV, PRINCIPAL_NAV_GROUPS, SETTINGS_NAV, SETTINGS_NAV_GROUPS,
  SUPER_ADMIN_NAV, SUPER_ADMIN_NAV_GROUPS,
  TEACHER_NAV, REGISTRAR_NAV, BURSAR_NAV, PARENT_NAV, STUDENT_NAV, SCHOOL_PAGES,
  getMainNavForRole, getNavGroupsForRole, settingsGroupsForRole, hasWholeSettings, pageCapability, mayOpenPage, visibleNavGroups,
} from '../navigation';
import { CAPABILITIES, roleHolds } from '../capabilities';

const singular = (label: string) => label.toLowerCase().replace(/s$/, '');

describe('the platform-admin sidebar', () => {
  it('is the eleven platform pages in four groups, each with a description, none twice', () => {
    expect(SUPER_ADMIN_NAV).toHaveLength(11);
    expect(SUPER_ADMIN_NAV_GROUPS.map((g) => g.items.length)).toEqual([3, 3, 2, 3]);
    expect(new Set(SUPER_ADMIN_NAV.map((i) => i.href)).size).toBe(11);
    expect(new Set(SUPER_ADMIN_NAV.map((i) => singular(i.label))).size).toBe(11);
    for (const i of SUPER_ADMIN_NAV) expect(`${i.label}: ${i.description ?? ''}`.length).toBeGreaterThan(i.label.length + 10);
  });

  it('is what a super admin gets — the platform pages, not the school-side principal list', () => {
    expect(getMainNavForRole('super_admin')).toBe(SUPER_ADMIN_NAV);
    expect(getMainNavForRole('principal')).toBe(PRINCIPAL_NAV);
    expect(hasWholeSettings('super_admin')).toBe(false);
    expect(hasWholeSettings('principal')).toBe(true);
    expect(hasWholeSettings('bursar')).toBe(false);
  });
});

describe('the principal sidebar', () => {
  it('is sixteen daily links in five groups', () => {
    expect(PRINCIPAL_NAV).toHaveLength(16);
    expect(PRINCIPAL_NAV_GROUPS.map((g) => g.items.length)).toEqual([2, 3, 4, 3, 4]);
    // The principal has everything the bursar has (Moses, 8 Oct 2026): the fee pages are in their sidebar.
    expect(PRINCIPAL_NAV_GROUPS.map((g) => g.label)).toEqual(['Overview', 'Academics', 'Students', 'Communication', 'Fees']);
    // Promotions is the registrar's page; the principal reaches it since 8 Oct 2026.
    expect(PRINCIPAL_NAV.map((i) => i.href)).toContain('/registrar/promotions');
  });

  it('keeps settings as thirteen links in three groups', () => {
    expect(SETTINGS_NAV).toHaveLength(13);
    expect(SETTINGS_NAV_GROUPS.map((g) => g.items.length)).toEqual([6, 4, 3]);
  });

  it('has no two labels naming the same thing, singular or plural, across both sections', () => {
    const labels = [...PRINCIPAL_NAV, ...SETTINGS_NAV].map((i) => singular(i.label));
    const seen = new Map<string, number>();
    for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([l]) => l)).toEqual([]);
  });

  it('has no two links to the same place within a section', () => {
    for (const list of [PRINCIPAL_NAV, SETTINGS_NAV]) {
      expect(new Set(list.map((i) => i.href)).size).toBe(list.length);
    }
  });

  it('gives every settings screen a one-line description for the index page', () => {
    expect(SETTINGS_NAV.filter((i) => !i.description).map((i) => i.label)).toEqual([]);
  });

  it('gives other roles one group, labelled by role, with their links unchanged', () => {
    expect(getNavGroupsForRole('teacher').map((g) => [g.label, g.items.length])).toEqual([['Teaching', 9]]);
    expect(getNavGroupsForRole('bursar').map((g) => [g.label, g.items.length])).toEqual([['Bursar', 7]]);
    expect(getNavGroupsForRole('registrar').map((g) => [g.label, g.items.length])).toEqual([['Registrar', 4]]);
    expect(getNavGroupsForRole('parent')).toEqual([]);
  });

  it('hides a tier-gated link without leaving an empty group behind', () => {
    const basic = visibleNavGroups(PRINCIPAL_NAV_GROUPS, ['/principal/analytics']);
    expect(basic.flatMap((g) => g.items)).toHaveLength(15);
    const overviewOnly = visibleNavGroups(PRINCIPAL_NAV_GROUPS, ['/principal/dashboard', '/principal/analytics']);
    expect(overviewOnly.map((g) => g.label)).toEqual(['Academics', 'Students', 'Communication', 'Fees']);
  });
});

describe('the settings pages a role is shown', () => {
  const hrefs = (role: string) => settingsGroupsForRole(role).flatMap((g) => g.items).map((i) => i.href);

  it('are every one for the principal, the payout pair for the bursar, Roster for the registrar, and none for anyone else', () => {
    expect(settingsGroupsForRole('principal')).toEqual(SETTINGS_NAV_GROUPS);
    expect(hrefs('bursar')).toEqual(['/settings/payout', '/settings/billing']);
    expect(hrefs('registrar')).toEqual(['/settings/roster']);
    for (const role of ['teacher', 'parent', 'student', 'super_admin', '']) {
      expect({ role, groups: settingsGroupsForRole(role) }).toEqual({ role, groups: [] });
    }
  });
});

/**
 * Every school page names its job from the one table (lib/capabilities.json, the API's copy), and is shown only to
 * the roles that hold it (spec 2026-10-08). A link the role's own guard would refuse is the fault this catches.
 */
describe('the sidebars read the table', () => {
  const SIDEBARS: Array<[string, typeof PRINCIPAL_NAV]> = [
    ['principal', PRINCIPAL_NAV], ['teacher', TEACHER_NAV], ['registrar', REGISTRAR_NAV], ['bursar', BURSAR_NAV],
    ['parent', PARENT_NAV], ['student', STUDENT_NAV],
  ];

  it('every school page names a capability the table has', () => {
    const pages = [...SCHOOL_PAGES, ...PARENT_NAV, ...STUDENT_NAV];
    expect(pages.filter((p) => !p.capability || !CAPABILITIES.includes(p.capability)).map((p) => p.href)).toEqual([]);
  });

  it.each(SIDEBARS)("every link in the %s's sidebar is a job the %s holds", (role, items) => {
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((i) => !roleHolds(role, i.capability!)).map((i) => i.href)).toEqual([]);
  });

  it('one address names one job, wherever it is listed', () => {
    const seen = new Map<string, string>();
    for (const p of SCHOOL_PAGES) {
      const prior = seen.get(p.href);
      expect({ href: p.href, capability: prior ?? p.capability }).toEqual({ href: p.href, capability: p.capability });
      seen.set(p.href, p.capability!);
    }
  });
});

describe('a typed address meets the same rule as the sidebar', () => {
  it('lets a role open its own pages, and below them', () => {
    expect(mayOpenPage('bursar', '/registrar/students')).toBe(true);
    expect(mayOpenPage('bursar', '/registrar/students/0b7c')).toBe(true);
    expect(mayOpenPage('registrar', '/settings/roster')).toBe(true);
    expect(mayOpenPage('principal', '/bursar/invoices')).toBe(true);
  });

  it("refuses a page the role's job does not include, the most specific page deciding", () => {
    expect(mayOpenPage('teacher', '/bursar/invoices')).toBe(false);
    expect(mayOpenPage('teacher', '/settings/identity')).toBe(false);
    expect(mayOpenPage('teacher', '/principal/attendance')).toBe(false);
    expect(mayOpenPage('bursar', '/registrar/students/import')).toBe(false);
    expect(mayOpenPage('bursar', '/registrar/promotions')).toBe(false);
    expect(mayOpenPage('registrar', '/settings/roster/import')).toBe(false);
    expect(pageCapability('/settings/roster/import')).toBe('roster.teaching');
  });

  it('leaves a page with no rule open (the Settings index lists only what the role may open)', () => {
    expect(pageCapability('/settings')).toBeUndefined();
    expect(mayOpenPage('teacher', '/settings')).toBe(true);
  });
});
