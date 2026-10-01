import { getNavGroupsForRole, visibleNavGroups, settingsAccessForRole, SETTINGS_NAV_GROUPS } from './navigation';

/**
 * The Ctrl+K palette's index: pages only, and only pages this role can open.
 *
 * There is deliberately no list of pages here. Entries come from the same calls the dashboard
 * sidebar makes — getNavGroupsForRole (built on getMainNavForRole) for the role's own pages,
 * which for a super admin are the platform pages — and SETTINGS_NAV_GROUPS gated by
 * settingsAccessForRole, the same rule the school sidebar reads: all, Payout Setup only, or
 * none. A second list would drift from the sidebar and start offering pages the role cannot
 * open — a 403 the palette itself caused. (Precedent: the notices class picker takes its
 * classes from the same request that lists the notices.)
 *
 * No search of students, teachers or other records: that needs its own API, tenant scoping and
 * per-record permissions, and is not this.
 */
export interface PaletteEntry {
  label: string;
  href: string;
  /** Shown beside the label, so "Attendance" under Students reads differently from a teacher's. */
  group: string;
  description?: string;
}

export function paletteEntriesForRole(role: string): PaletteEntry[] {
  const own = visibleNavGroups(getNavGroupsForRole(role), []).flatMap((g) =>
    g.items.map((i) => ({ label: i.label, href: i.href, group: g.label, description: i.description })),
  );
  const access = settingsAccessForRole(role);
  let settings: PaletteEntry[] = [];
  if (access === 'all') {
    settings = visibleNavGroups(SETTINGS_NAV_GROUPS, []).flatMap((g) =>
      g.items.map((i) => ({ label: i.label, href: i.href, group: `Settings · ${g.label}`, description: i.description })),
    );
  } else if (access === 'payout') {
    settings = SETTINGS_NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => i.href === '/settings/payout')
      .map((i) => ({ label: i.label, href: i.href, group: 'Settings', description: i.description }));
  }
  return [...own, ...settings];
}

/**
 * Case-insensitive; every word of the query must appear in the label or the description, so
 * "export" finds Data Export and "pass mark" finds the grading pages, whose descriptions say it.
 * An empty query returns everything, so the list is usable by tapping alone.
 */
export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((e) => {
    const haystack = `${e.label} ${e.description ?? ''}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
