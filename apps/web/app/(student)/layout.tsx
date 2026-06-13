'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/app/providers';
import { STUDENT_NAV } from '@/lib/navigation';
import NotificationBell from '@/components/NotificationBell';
import SyncIndicator from '@/components/SyncIndicator';

function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 flex shadow-[0_-4px_6px_-4px_rgb(0_0_0_/_0.05)]">
      {STUDENT_NAV.map(item => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/');
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`relative flex-1 flex flex-col items-center justify-center py-2.5 text-xs font-medium transition-colors duration-200 ${
              active ? 'text-[#003366]' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            <span className={`absolute top-0 inset-x-3 h-0.5 rounded-full transition-colors duration-200 ${active ? 'bg-[#FF761B]' : 'bg-transparent'}`} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function StudentChrome({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="shrink-0 bg-gradient-to-r from-[#003366] to-[#002244] text-white px-4 py-3 flex items-center justify-between">
        <p className="font-heading text-sm font-semibold">Chronix Edu — Student</p>
        <div className="flex items-center gap-1">
          <SyncIndicator variant="light" />
          <NotificationBell variant="light" />
          <button
            type="button"
            onClick={handleLogout}
            className="text-xs font-medium text-white/80 hover:text-white px-2 transition-colors duration-200"
          >
            Sign out
          </button>
        </div>
      </header>
      <main key={pathname} className="flex-1 min-w-0 pb-16 page-transition">{children}</main>
      <BottomNav />
    </div>
  );
}

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <StudentChrome>{children}</StudentChrome>;
}
