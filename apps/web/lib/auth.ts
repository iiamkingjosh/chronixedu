// Who may open which page is the one table (lib/capabilities.ts, roleHolds), not role lists here: the three
// lists this file kept (settings, payout, platform billing) went on 8 Oct 2026.

/** Default landing path after login, by role. */
export function getDefaultDashboardPath(role: string): string {
  switch (role) {
    case 'teacher':
      return '/teacher/dashboard';
    case 'registrar':
      return '/registrar/students';
    case 'bursar':
      return '/bursar/fee-structures';
    case 'principal':
      return '/principal/dashboard';
    case 'super_admin':
      return '/super-admin/dashboard';
    case 'parent':
      return '/parent/dashboard';
    case 'student':
      return '/student/dashboard';
    default:
      return '/settings/identity';
  }
}
