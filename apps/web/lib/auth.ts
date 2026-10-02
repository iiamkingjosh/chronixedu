/** Roles that can access school settings pages. */
export const ADMIN_ROLES = ['principal', 'super_admin'] as const;

export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Roles that can access the payout settings page specifically (narrower than full settings access). */
export const PAYOUT_SETTINGS_ROLES = ['principal', 'bursar', 'super_admin'] as const;

export function canAccessPayoutSettings(role: string): boolean {
  return (PAYOUT_SETTINGS_ROLES as readonly string[]).includes(role);
}

/** Roles that can access the Platform Billing page — paying Chronix for this school's own
 *  subscription. Same roles as payout settings: the two money-handling screens travel
 *  together (lib/navigation.ts's settingsAccessForRole), and this mirrors the API's own
 *  requireRole('principal', 'bursar', 'super_admin') on routes/platformBilling.ts. */
export const PLATFORM_BILLING_ROLES = ['principal', 'bursar', 'super_admin'] as const;

export function canAccessPlatformBilling(role: string): boolean {
  return (PLATFORM_BILLING_ROLES as readonly string[]).includes(role);
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
