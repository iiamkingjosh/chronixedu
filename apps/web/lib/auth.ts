/** Roles that can access school settings pages. */
export const ADMIN_ROLES = ['principal', 'super_admin'] as const;

export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

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
