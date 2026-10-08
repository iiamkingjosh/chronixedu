'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/providers';
import { getDefaultDashboardPath } from '@/lib/auth';

// The principal too (Moses, 8 Oct 2026: the principal can do the registrar's work). The principal's
// Students link pointed here and this list sent them back to their dashboard, so registering a student,
// Assign Class, imports and Promotions were out of a principal's reach while the API allowed them
// (audit, 8 Oct 2026).
const ALLOWED_ROLES = ['registrar', 'principal', 'super_admin'];

export default function RegistrarLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user && !ALLOWED_ROLES.includes(user.role)) {
      router.replace(getDefaultDashboardPath(user.role));
    }
  }, [loading, user, router]);

  if (loading || !user || !ALLOWED_ROLES.includes(user.role)) {
    return null;
  }

  return <>{children}</>;
}
