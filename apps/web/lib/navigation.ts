import { roleHolds, type Capability } from './capabilities';

export interface NavItem {
  label: string;
  href: string;
  /** One line for an index page: what the screen is for. Settings items carry one. */
  description?: string;
  /**
   * The job the page is for, from the one table (lib/capabilities.json). Every school page names one, and is shown
   * only to roles that hold it; a platform page names none. Since 8 Oct 2026 (spec 2026-10-08).
   */
  capability?: Capability;
}

/** A labelled run of links. A principal reads five of these instead of a list of sixteen. */
export interface NavGroup {
  label: string;
  items: NavItem[];
}

// Sixteen links in five groups. Promotions joined Students on 8 Oct 2026, when the principal was given the
// registrar's work, and Fees joined the same day, when the principal was given everything the bursar has.
// Order within a group never changes and nothing reorders itself by usage: a principal
// signs in a few times a week and needs the menu where it was last time.
export const PRINCIPAL_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', href: '/principal/dashboard', capability: 'school.overview' },
      { label: 'Analytics', href: '/principal/analytics', capability: 'school.overview' },
    ],
  },
  {
    label: 'Academics',
    items: [
      { label: 'Results', href: '/principal/results', capability: 'results.manage' },
      { label: 'Report Cards', href: '/principal/report-cards', capability: 'results.manage' },
      { label: 'Timetable', href: '/principal/timetable', capability: 'timetable.manage' },
    ],
  },
  {
    label: 'Students',
    items: [
      { label: 'Students', href: '/registrar/students', capability: 'students.view' },
      { label: 'Promotions', href: '/registrar/promotions', capability: 'students.manage' },
      { label: 'Attendance', href: '/principal/attendance', capability: 'school.overview' },
      { label: 'Behaviour', href: '/principal/behaviour', capability: 'school.overview' },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Messages', href: '/principal/messages', capability: 'school.member' },
      { label: 'Announcements', href: '/principal/announcements', capability: 'announcements.post' },
      { label: 'Class Notices', href: '/notices', capability: 'class.daily' },
    ],
  },
  {
    label: 'Fees',
    items: [
      { label: 'Fee Structures', href: '/bursar/fee-structures', capability: 'fees.manage' },
      { label: 'Invoices', href: '/bursar/invoices', capability: 'fees.manage' },
      { label: 'Outstanding Balances', href: '/bursar/outstanding', capability: 'fees.manage' },
      { label: 'Collection Summary', href: '/bursar/collections', capability: 'fees.manage' },
    ],
  },
];

export const PRINCIPAL_NAV: NavItem[] = PRINCIPAL_NAV_GROUPS.flatMap((g) => g.items);

export const TEACHER_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/teacher/dashboard', capability: 'teacher.workspace' },
  { label: 'Timetable', href: '/teacher/timetable', capability: 'school.member' },
  { label: 'Score Entry', href: '/teacher/scores', capability: 'results.enter' },
  { label: 'Class Comments', href: '/teacher/class-comments', capability: 'class.comments' },
  { label: 'Attendance', href: '/teacher/attendance', capability: 'class.daily' },
  { label: 'Assignments', href: '/teacher/assignments', capability: 'teacher.workspace' },
  { label: 'Behaviour', href: '/teacher/behaviour', capability: 'class.daily' },
  { label: 'Class Notices', href: '/notices', capability: 'class.daily' },
  { label: 'Messages', href: '/teacher/messages', capability: 'school.member' },
];

// Settings is set-up work, not daily work: one sidebar entry, these groups behind it
// (settings/layout.tsx), and /settings an index that says what each screen is for.
// "School-wide Grading" and "Grading by Level" stay two pages on purpose. One page with a
// level selector would show a level's EFFECTIVE values — the school-wide ones, for a level
// with no override — and any save from it would pin them (CLAUDE.md doctrine 8).
export const SETTINGS_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Setup',
    items: [
      { label: 'School Identity', href: '/settings/identity', description: 'Name, motto, logo, colours and contact details — on report cards and in the app.', capability: 'school.setup' },
      { label: 'Academic Structure', href: '/settings/academic-structure', description: 'Sessions and terms, and which term is current.', capability: 'school.setup' },
      { label: 'Roster', href: '/settings/roster', description: 'Classes, subjects, and which teacher takes which subject in which class, per term.', capability: 'roster.classes_subjects' },
      { label: 'Users', href: '/settings/users', description: 'Accounts, roles and access.', capability: 'staff.manage' },
      { label: 'Notifications', href: '/settings/notifications', description: 'How staff and parents are notified about school events.', capability: 'school.setup' },
      { label: 'Data Export', href: '/settings/export', description: 'Download all of the school’s records as spreadsheets (CSV).', capability: 'school.export' },
    ],
  },
  {
    label: 'Grading & Reports',
    items: [
      { label: 'School-wide Grading', href: '/settings/grading-scale', description: 'The grade bands and pass mark every class uses unless a level overrides them.', capability: 'school.setup' },
      { label: 'Grading by Level', href: '/settings/level-grading', description: 'A different pass mark or grade bands for one section — Primary, JSS, SSS.', capability: 'school.setup' },
      { label: 'Assessment Config', href: '/settings/assessment-config', description: 'The assessment components — CA, exam — and their weights.', capability: 'school.setup' },
      { label: 'Report Card Template', href: '/settings/report-card', description: 'Report card layout and generation settings.', capability: 'school.setup' },
    ],
  },
  {
    label: 'Fees',
    items: [
      { label: 'Fee Settings', href: '/settings/fees', description: 'Fee rules: the minimum part payment, and who pays the convenience fee online.', capability: 'school.setup' },
      { label: 'Payout Setup', href: '/settings/payout', description: 'The bank account parents\u2019 fee payments settle to. Chronix never touches this money.', capability: 'school.payout.view' },
      { label: 'Platform Billing', href: '/settings/billing', description: 'What this school pays Chronix for its own subscription, and paying it online.', capability: 'school.billing' },
    ],
  },
];

export const SETTINGS_NAV: NavItem[] = SETTINGS_NAV_GROUPS.flatMap((g) => g.items);

export const REGISTRAR_NAV: NavItem[] = [
  { label: 'Students', href: '/registrar/students', capability: 'students.view' },
  { label: 'Promotions', href: '/registrar/promotions', capability: 'students.manage' },
  { label: 'Messages', href: '/registrar/messages', capability: 'school.member' },
  { label: 'Announcements', href: '/registrar/announcements', capability: 'school.member' },
];

// Students, read-only, joined on 8 Oct 2026: the bursar looks a child up to invoice them (spec decision 3).
export const BURSAR_NAV: NavItem[] = [
  { label: 'Fee Structures', href: '/bursar/fee-structures', capability: 'fees.manage' },
  { label: 'Invoices', href: '/bursar/invoices', capability: 'fees.manage' },
  { label: 'Outstanding Balances', href: '/bursar/outstanding', capability: 'fees.manage' },
  { label: 'Collection Summary', href: '/bursar/collections', capability: 'fees.manage' },
  { label: 'Students', href: '/registrar/students', capability: 'students.view' },
  { label: 'Messages', href: '/bursar/messages', capability: 'school.member' },
  { label: 'Announcements', href: '/bursar/announcements', capability: 'school.member' },
];

export const PARENT_NAV: NavItem[] = [
  { label: 'Home', href: '/parent/dashboard', capability: 'parent.portal' },
  { label: 'Results', href: '/parent/results', capability: 'parent.portal' },
  { label: 'Attendance', href: '/parent/attendance', capability: 'parent.portal' },
  { label: 'Notices', href: '/parent/notices', capability: 'parent.portal' },
  { label: 'Messages', href: '/parent/messages', capability: 'school.member' },
  { label: 'Fees', href: '/parent/fees', capability: 'parent.portal' },
];

// The platform-admin area (app/super-admin/layout.tsx). Lived as a private list inside that
// layout until 1 Oct 2026; moved here so the sidebar and the Ctrl+K palette read one source.
export const SUPER_ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Platform',
    items: [
      { label: 'Dashboard', href: '/super-admin/dashboard', description: 'Platform overview: schools, subscriptions and recent activity.' },
      { label: 'Analytics', href: '/super-admin/analytics', description: 'Platform-wide figures: schools, students and revenue.' },
      { label: 'Health', href: '/super-admin/health', description: 'Service status, scheduled jobs and recent errors.' },
    ],
  },
  {
    label: 'Schools',
    items: [
      { label: 'Schools', href: '/super-admin/schools', description: 'Every school: details, users, suspension and data.' },
      { label: 'Onboarding', href: '/super-admin/onboard', description: 'Set up a new school, step by step.' },
      { label: 'Subscriptions', href: '/super-admin/subscriptions', description: 'Plans, billing, trial extensions and recorded payments.' },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Announcements', href: '/super-admin/announcements', description: 'Messages from Chronix to schools on the platform.' },
      { label: 'Support', href: '/super-admin/support', description: 'Support sessions: view a school as one of its users.' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Audit Logs', href: '/super-admin/audit', description: 'Who did what across the platform, and when.' },
      { label: 'Platform Admins', href: '/super-admin/admins', description: 'Chronix staff accounts with platform access.' },
      { label: 'Two-factor Sign-in', href: '/super-admin/security', description: 'Your authenticator app and recovery codes.' },
    ],
  },
];

export const SUPER_ADMIN_NAV: NavItem[] = SUPER_ADMIN_NAV_GROUPS.flatMap((g) => g.items);

export const STUDENT_NAV: NavItem[] = [
  { label: 'Home', href: '/student/dashboard', capability: 'student.portal' },
  { label: 'Timetable', href: '/student/timetable', capability: 'school.member' },
  { label: 'Results', href: '/student/results', capability: 'student.portal' },
  { label: 'Assignments', href: '/student/assignments', capability: 'student.portal' },
  { label: 'Notices', href: '/student/notices', capability: 'student.portal' },
  { label: 'Messages', href: '/student/messages', capability: 'school.member' },
];

/**
 * A super admin's pages are the PLATFORM pages. It returned PRINCIPAL_NAV until 1 Oct 2026, but a
 * super admin has no school (school_id is null), so school pages called /api/schools/null/…;
 * a school is reached as one of its users through a support session, whose token carries that
 * user's role.
 */
export function getMainNavForRole(role: string): NavItem[] {
  if (role === 'teacher') return TEACHER_NAV;
  if (role === 'registrar') return REGISTRAR_NAV;
  if (role === 'bursar') return BURSAR_NAV;
  if (role === 'principal') return PRINCIPAL_NAV;
  if (role === 'super_admin') return SUPER_ADMIN_NAV;
  return [];
}

/**
 * The school Settings pages a role may open, in their groups: those whose capability the role holds (all thirteen
 * for the principal; Payout Setup and Platform Billing for the bursar; Roster for the registrar). Read by the
 * dashboard sidebar, the Settings rail (settings/layout.tsx), the Settings index and the palette. A platform admin
 * gets none here: no school of their own (see getMainNavForRole).
 */
export function settingsGroupsForRole(role: string): NavGroup[] {
  if (role === 'super_admin') return [];
  return SETTINGS_NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => i.capability !== undefined && roleHolds(role, i.capability)) }))
    .filter((g) => g.items.length > 0);
}

/**
 * Whether a role has the whole Settings area (school setup), shown as one sidebar entry; a role with only some
 * settings pages has them listed in the sidebar instead.
 */
export function hasWholeSettings(role: string): boolean {
  return role !== 'super_admin' && roleHolds(role, 'school.setup');
}

/** School pages no sidebar links to, each with the job it is for. */
export const UNLINKED_SCHOOL_PAGES: NavItem[] = [
  { label: 'Import students', href: '/registrar/students/import', capability: 'students.manage' },
  { label: 'Import roster', href: '/settings/roster/import', capability: 'roster.teaching' },
  { label: 'Import staff', href: '/settings/users/import', capability: 'staff.manage' },
  { label: 'Import fees', href: '/bursar/fee-structures/import', capability: 'fees.manage' },
];

/** Every school page with its capability, from every list. */
export const SCHOOL_PAGES: NavItem[] = [
  ...PRINCIPAL_NAV, ...TEACHER_NAV, ...REGISTRAR_NAV, ...BURSAR_NAV, ...SETTINGS_NAV, ...UNLINKED_SCHOOL_PAGES,
];

/**
 * The capability a school page needs: that of the longest page address the path falls under, or undefined when no
 * page names one (the Settings index, which lists only what the role may open). The dashboard layout refuses a page
 * whose capability the role does not hold, so a typed address meets the same rule as the sidebar.
 */
export function pageCapability(pathname: string): Capability | undefined {
  let best: NavItem | undefined;
  for (const page of SCHOOL_PAGES) {
    if (pathname === page.href || pathname.startsWith(page.href + '/')) {
      if (!best || page.href.length > best.href.length) best = page;
    }
  }
  return best?.capability;
}

export function mayOpenPage(role: string, pathname: string): boolean {
  const cap = pageCapability(pathname);
  return cap === undefined || roleHolds(role, cap);
}

/** The sidebar's groups for a role: the principal's five, the platform's four, or one group labelled by role. */
export function getNavGroupsForRole(role: string): NavGroup[] {
  if (role === 'principal') return PRINCIPAL_NAV_GROUPS;
  if (role === 'super_admin') return SUPER_ADMIN_NAV_GROUPS;
  const label = role === 'teacher' ? 'Teaching' : role === 'registrar' ? 'Registrar' : role === 'bursar' ? 'Bursar' : null;
  const items = getMainNavForRole(role);
  return label && items.length > 0 ? [{ label, items }] : [];
}

/** Drop the links a tier does not include, and any group that is left empty. */
export function visibleNavGroups(groups: NavGroup[], hiddenHrefs: string[]): NavGroup[] {
  if (hiddenHrefs.length === 0) return groups;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !hiddenHrefs.includes(i.href)) }))
    .filter((g) => g.items.length > 0);
}
