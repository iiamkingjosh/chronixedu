'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/app/providers';
import { isAdminRole } from '@/lib/auth';
import { getMainNavForRole, SETTINGS_NAV, type NavItem } from '@/lib/navigation';
import NotificationBell from '@/components/NotificationBell';
import SyncIndicator from '@/components/SyncIndicator';

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = pathname === item.href || pathname.startsWith(item.href + '/');
  return (
    <Link
      href={item.href}
      className={`nav-link flex items-center px-4 py-2.5 text-sm font-medium mx-2 rounded-md ${
        active
          ? 'nav-link-active bg-white/10 text-white'
          : 'border-l-[3px] border-transparent text-white/70 hover:bg-white/5 hover:text-white'
      }`}
    >
      {item.label}
    </Link>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
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

  const mainNav = getMainNavForRole(user.role);
  const showSettings = isAdminRole(user.role);

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <aside className="w-60 shrink-0 bg-gradient-to-b from-[#003366] to-[#002244] flex flex-col">
        <div className="px-5 py-5 border-b border-white/10">
          <p className="font-heading text-lg font-semibold text-white">Chronix Edu</p>
          <p className="text-xs text-white/50 mt-0.5 truncate">{user.email}</p>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">
          {mainNav.length > 0 && (
            <div className="mb-4">
              <p className="px-5 mb-2 text-xs font-semibold text-white/40 uppercase tracking-widest">
                {user.role === 'teacher' ? 'Teaching' : user.role === 'registrar' ? 'Registrar' : user.role === 'bursar' ? 'Bursar' : 'Principal'}
              </p>
              {mainNav.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
          )}

          {showSettings && (
            <div>
              <p className="px-5 mb-2 text-xs font-semibold text-white/40 uppercase tracking-widest">
                Settings
              </p>
              {SETTINGS_NAV.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
          )}
        </nav>

        <div className="px-4 py-4 border-t border-white/10">
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-md border border-white/10 px-3 py-2 text-sm font-medium text-white/70 hover:bg-white/5 hover:text-white transition-colors duration-200"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="shrink-0 bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <p className="text-sm text-gray-500 capitalize">{user.role.replace('_', ' ')}</p>
          <div className="flex items-center gap-1">
            <SyncIndicator variant="dark" />
            <NotificationBell variant="dark" />
          </div>
        </header>
        <main key={pathname} className="flex-1 min-w-0 overflow-y-auto page-transition">{children}</main>
      </div>
    </div>
  );
}
