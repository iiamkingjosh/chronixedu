import { paletteEntriesForRole, filterPalette } from '../commandPalette';
import { getMainNavForRole, SETTINGS_NAV } from '../navigation';
import { isAdminRole, canAccessPayoutSettings } from '../auth';

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
  const settings = isAdminRole(role)
    ? SETTINGS_NAV.map((i) => i.href)
    : canAccessPayoutSettings(role) ? ['/settings/payout'] : [];
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
