/// <reference types="jest" />
/**
 * The principal's sidebar: eleven daily links in four groups, and thirteen settings links in
 * three, behind one entry. Pins the structure, and the one property a plain equality check
 * cannot see — "Report Cards" beside "Report Card" was a wrong-click generator and is not a
 * duplicate to `===`. Labels are compared lowercased with a trailing "s" removed, which is
 * what makes this test fail on the labels that motivated it.
 */
import {
  PRINCIPAL_NAV, PRINCIPAL_NAV_GROUPS, SETTINGS_NAV, SETTINGS_NAV_GROUPS,
  SUPER_ADMIN_NAV, SUPER_ADMIN_NAV_GROUPS,
  getMainNavForRole, getNavGroupsForRole, settingsAccessForRole, visibleNavGroups,
} from '../navigation';

const singular = (label: string) => label.toLowerCase().replace(/s$/, '');

describe('the platform-admin sidebar', () => {
  it('is the ten platform pages in four groups, each with a description, none twice', () => {
    expect(SUPER_ADMIN_NAV).toHaveLength(10);
    expect(SUPER_ADMIN_NAV_GROUPS.map((g) => g.items.length)).toEqual([3, 3, 2, 2]);
    expect(new Set(SUPER_ADMIN_NAV.map((i) => i.href)).size).toBe(10);
    expect(new Set(SUPER_ADMIN_NAV.map((i) => singular(i.label))).size).toBe(10);
    for (const i of SUPER_ADMIN_NAV) expect(`${i.label}: ${i.description ?? ''}`.length).toBeGreaterThan(i.label.length + 10);
  });

  it('is what a super admin gets — the platform pages, not the school-side principal list', () => {
    expect(getMainNavForRole('super_admin')).toBe(SUPER_ADMIN_NAV);
    expect(getMainNavForRole('principal')).toBe(PRINCIPAL_NAV);
    expect(settingsAccessForRole('super_admin')).toBe('none');
    expect(settingsAccessForRole('principal')).toBe('all');
    expect(settingsAccessForRole('bursar')).toBe('payout');
  });
});

describe('the principal sidebar', () => {
  it('is eleven daily links in four groups of two or three', () => {
    expect(PRINCIPAL_NAV).toHaveLength(11);
    expect(PRINCIPAL_NAV_GROUPS.map((g) => g.items.length)).toEqual([2, 3, 3, 3]);
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
    expect(getNavGroupsForRole('bursar').map((g) => [g.label, g.items.length])).toEqual([['Bursar', 6]]);
    expect(getNavGroupsForRole('registrar').map((g) => [g.label, g.items.length])).toEqual([['Registrar', 4]]);
    expect(getNavGroupsForRole('parent')).toEqual([]);
  });

  it('hides a tier-gated link without leaving an empty group behind', () => {
    const basic = visibleNavGroups(PRINCIPAL_NAV_GROUPS, ['/principal/analytics']);
    expect(basic.flatMap((g) => g.items)).toHaveLength(10);
    const overviewOnly = visibleNavGroups(PRINCIPAL_NAV_GROUPS, ['/principal/dashboard', '/principal/analytics']);
    expect(overviewOnly.map((g) => g.label)).toEqual(['Academics', 'Students', 'Communication']);
  });
});
