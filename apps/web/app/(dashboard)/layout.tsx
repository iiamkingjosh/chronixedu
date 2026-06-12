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
      className={`flex items-center px-4 py-2.5 text-sm font-medium rounded-lg mx-2 transition-colors ${
        active
          ? 'bg-[#003366] text-white'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
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
      <aside className="w-60 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-5 py-5 border-b border-gray-200">
          <p className="text-lg font-semibold text-[#003366]">Chronix Edu</p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{user.email}</p>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">
          {mainNav.length > 0 && (
            <div className="mb-4">
              <p className="px-5 mb-2 text-xs font-semibold text-gray-400 uppercase tracking-widest">
                {user.role === 'teacher' ? 'Teaching' : user.role === 'registrar' ? 'Registrar' : user.role === 'bursar' ? 'Bursar' : 'Principal'}
              </p>
              {mainNav.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
          )}

          {showSettings && (
            <div>
              <p className="px-5 mb-2 text-xs font-semibold text-gray-400 uppercase tracking-widest">
                Settings
              </p>
              {SETTINGS_NAV.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
          )}
        </nav>

        <div className="px-4 py-4 border-t border-gray-200">
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
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
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
