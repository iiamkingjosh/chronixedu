export interface NavItem {
  label: string;
  href: string;
}

export const PRINCIPAL_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/principal/dashboard' },
  { label: 'Analytics', href: '/principal/analytics' },
  { label: 'Timetable', href: '/principal/timetable' },
  { label: 'Results', href: '/principal/results' },
  { label: 'Report Cards', href: '/principal/report-cards' },
  { label: 'Attendance', href: '/principal/attendance' },
  { label: 'Behaviour', href: '/principal/behaviour' },
  { label: 'Messages', href: '/principal/messages' },
  { label: 'Announcements', href: '/principal/announcements' },
];

export const TEACHER_NAV: NavItem[] = [
  { label: 'Dashboard', href: '/teacher/dashboard' },
  { label: 'Timetable', href: '/teacher/timetable' },
  { label: 'Score Entry', href: '/teacher/scores' },
  { label: 'Class Comments', href: '/teacher/class-comments' },
  { label: 'Attendance', href: '/teacher/attendance' },
  { label: 'Assignments', href: '/teacher/assignments' },
  { label: 'Behaviour', href: '/teacher/behaviour' },
  { label: 'Messages', href: '/teacher/messages' },
];

export const SETTINGS_NAV: NavItem[] = [
  { label: 'School Identity', href: '/settings/identity' },
  { label: 'Academic Structure', href: '/settings/academic-structure' },
  { label: 'Grading Scale', href: '/settings/grading-scale' },
  { label: 'Assessment Config', href: '/settings/assessment-config' },
  { label: 'Report Card', href: '/settings/report-card' },
  { label: 'Notifications', href: '/settings/notifications' },
  { label: 'Users', href: '/settings/users' },
];

export const REGISTRAR_NAV: NavItem[] = [
  { label: 'Students', href: '/registrar/students' },
  { label: 'Promotions', href: '/registrar/promotions' },
];

export const BURSAR_NAV: NavItem[] = [
  { label: 'Fee Structures', href: '/bursar/fee-structures' },
  { label: 'Invoices', href: '/bursar/invoices' },
  { label: 'Outstanding Balances', href: '/bursar/outstanding' },
  { label: 'Collection Summary', href: '/bursar/collections' },
];

export const PARENT_NAV: NavItem[] = [
  { label: 'Home', href: '/parent/dashboard' },
  { label: 'Results', href: '/parent/results' },
  { label: 'Attendance', href: '/parent/attendance' },
  { label: 'Messages', href: '/parent/messages' },
  { label: 'Fees', href: '/parent/fees' },
];

export const STUDENT_NAV: NavItem[] = [
  { label: 'Home', href: '/student/dashboard' },
  { label: 'Timetable', href: '/student/timetable' },
  { label: 'Results', href: '/student/results' },
  { label: 'Assignments', href: '/student/assignments' },
  { label: 'Notices', href: '/student/notices' },
  { label: 'Messages', href: '/student/messages' },
];

export function getMainNavForRole(role: string): NavItem[] {
  if (role === 'teacher') return TEACHER_NAV;
  if (role === 'registrar') return REGISTRAR_NAV;
  if (role === 'bursar') return BURSAR_NAV;
  if (role === 'principal' || role === 'super_admin') return PRINCIPAL_NAV;
  return [];
}
