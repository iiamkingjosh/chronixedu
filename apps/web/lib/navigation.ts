import { isAdminRole, canAccessPayoutSettings } from './auth';

export interface NavItem {
  label: string;
  href: string;
  /** One line for an index page: what the screen is for. Settings items carry one. */
  description?: string;
}

/** A labelled run of links. A principal reads four of these instead of a list of eleven. */
export interface NavGroup {
  label: string;
  items: NavItem[];
}

// The same eleven links a principal always had, scanned as four groups of two or three.
// Order within a group never changes and nothing reorders itself by usage: a principal
// signs in a few times a week and needs the menu where it was last time.
export const PRINCIPAL_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', href: '/principal/dashboard' },
      { label: 'Analytics', href: '/principal/analytics' },
    ],
  },
  {
    label: 'Academics',
    items: [
      { label: 'Results', href: '/principal/results' },
      { label: 'Report Cards', href: '/principal/report-cards' },
      { label: 'Timetable', href: '/principal/timetable' },
    ],
  },
  {
    label: 'Students',
    items: [
      { label: 'Students', href: '/registrar/students' },
      { label: 'Attendance', href: '/principal/attendance' },
      { label: 'Behaviour', href: '/principal/behaviour' },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Messages', href: '/principal/messages' },
      { label: 'Announcements', href: '/principal/announcements' },
      { label: 'Class Notices', href: '/notices' },
    ],
  },
];

export const PRINCIPAL_NAV: NavItem[] = PRINCIPAL_NAV_GROUPS.flatMap((g) => g.items);

export const TEACHER_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/teacher/dashboard' },
  { label: 'Timetable', href: '/teacher/timetable' },
  { label: 'Score Entry', href: '/teacher/scores' },
  { label: 'Class Comments', href: '/teacher/class-comments' },
  { label: 'Attendance', href: '/teacher/attendance' },
  { label: 'Assignments', href: '/teacher/assignments' },
  { label: 'Behaviour', href: '/teacher/behaviour' },
  { label: 'Class Notices', href: '/notices' },
  { label: 'Messages', href: '/teacher/messages' },
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
      { label: 'School Identity', href: '/settings/identity', description: 'Name, motto, logo, colours and contact details — on report cards and in the app.' },
      { label: 'Academic Structure', href: '/settings/academic-structure', description: 'Sessions and terms, and which term is current.' },
      { label: 'Roster', href: '/settings/roster', description: 'Classes, subjects, and which teacher takes which subject in which class, per term.' },
      { label: 'Users', href: '/settings/users', description: 'Accounts, roles and access.' },
      { label: 'Notifications', href: '/settings/notifications', description: 'How staff and parents are notified about school events.' },
      { label: 'Data Export', href: '/settings/export', description: 'Download all of the school’s records as spreadsheets (CSV).' },
    ],
  },
  {
    label: 'Grading & Reports',
    items: [
      { label: 'School-wide Grading', href: '/settings/grading-scale', description: 'The grade bands and pass mark every class uses unless a level overrides them.' },
      { label: 'Grading by Level', href: '/settings/level-grading', description: 'A different pass mark or grade bands for one section — Primary, JSS, SSS.' },
      { label: 'Assessment Config', href: '/settings/assessment-config', description: 'The assessment components — CA, exam — and their weights.' },
      { label: 'Report Card Template', href: '/settings/report-card', description: 'Report card layout and generation settings.' },
    ],
  },
  {
    label: 'Fees',
    items: [
      { label: 'Fee Settings', href: '/settings/fees', description: 'Fee rules: the minimum part payment, and who pays the convenience fee online.' },
      { label: 'Payout Setup', href: '/settings/payout', description: 'The bank account parents\u2019 fee payments settle to. Chronix never touches this money.' },
      { label: 'Platform Billing', href: '/settings/billing', description: 'What this school pays Chronix for its own subscription, and paying it online.' },
    ],
  },
];

export const SETTINGS_NAV: NavItem[] = SETTINGS_NAV_GROUPS.flatMap((g) => g.items);

export const REGISTRAR_NAV: NavItem[] = [
  { label: 'Students', href: '/registrar/students' },
  { label: 'Promotions', href: '/registrar/promotions' },
  { label: 'Messages', href: '/registrar/messages' },
  { label: 'Announcements', href: '/registrar/announcements' },
];

export const BURSAR_NAV: NavItem[] = [
  { label: 'Fee Structures', href: '/bursar/fee-structures' },
  { label: 'Invoices', href: '/bursar/invoices' },
  { label: 'Outstanding Balances', href: '/bursar/outstanding' },
  { label: 'Collection Summary', href: '/bursar/collections' },
  { label: 'Messages', href: '/bursar/messages' },
  { label: 'Announcements', href: '/bursar/announcements' },
];

export const PARENT_NAV: NavItem[] = [
  { label: 'Home', href: '/parent/dashboard' },
  { label: 'Results', href: '/parent/results' },
  { label: 'Attendance', href: '/parent/attendance' },
  { label: 'Notices', href: '/parent/notices' },
  { label: 'Messages', href: '/parent/messages' },
  { label: 'Fees', href: '/parent/fees' },
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
  { label: 'Home', href: '/student/dashboard' },
  { label: 'Timetable', href: '/student/timetable' },
  { label: 'Results', href: '/student/results' },
  { label: 'Assignments', href: '/student/assignments' },
  { label: 'Notices', href: '/student/notices' },
  { label: 'Messages', href: '/student/messages' },
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
 * Which school Settings pages a role reaches: all of them, only the two money-handling screens
 * (Payout Setup and Platform Billing — 'payout', the name predates Platform Billing joining it),
 * or none. One rule, read by the palette (lib/commandPalette.ts filters its 'payout' entries to
 * exactly those two hrefs) — the sidebar itself (settings/layout.tsx) shows every group to every
 * role and leaves the real gate to each page's own guard, backed by the API
 * (requireRole('principal', 'bursar', 'super_admin') on Platform Billing's own routes, same
 * roles canAccessPayoutSettings already names). A super admin gets none: no school of their own
 * (see getMainNavForRole).
 */
export function settingsAccessForRole(role: string): 'all' | 'payout' | 'none' {
  if (role === 'super_admin') return 'none';
  if (isAdminRole(role)) return 'all';
  if (canAccessPayoutSettings(role)) return 'payout';
  return 'none';
}

/** The sidebar's groups for a role: the principal's four, the platform's four, or one group labelled by role. */
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
