'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/providers';
import { getDefaultDashboardPath } from '@/lib/auth';

const ALLOWED_ROLES = ['registrar', 'super_admin'];

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
