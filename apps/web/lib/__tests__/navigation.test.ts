/// <reference types="jest" />
/**
 * The principal's sidebar: eleven daily links in four groups, and eleven settings links in
 * three, behind one entry. Pins the structure, and the one property a plain equality check
 * cannot see — "Report Cards" beside "Report Card" was a wrong-click generator and is not a
 * duplicate to `===`. Labels are compared lowercased with a trailing "s" removed, which is
 * what makes this test fail on the labels that motivated it.
 */
import {
  PRINCIPAL_NAV, PRINCIPAL_NAV_GROUPS, SETTINGS_NAV, SETTINGS_NAV_GROUPS,
  getNavGroupsForRole, visibleNavGroups,
} from '../navigation';

const singular = (label: string) => label.toLowerCase().replace(/s$/, '');

describe('the principal sidebar', () => {
  it('is eleven daily links in four groups of two or three', () => {
    expect(PRINCIPAL_NAV).toHaveLength(11);
    expect(PRINCIPAL_NAV_GROUPS.map((g) => g.items.length)).toEqual([2, 3, 3, 3]);
  });

  it('keeps settings as eleven links in three groups', () => {
    expect(SETTINGS_NAV).toHaveLength(11);
    expect(SETTINGS_NAV_GROUPS.map((g) => g.items.length)).toEqual([5, 4, 2]);
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
