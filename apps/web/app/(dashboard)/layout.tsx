'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { isAdminRole } from '@/lib/auth';
import { getMainNavForRole, SETTINGS_NAV, type NavItem } from '@/lib/navigation';
import NotificationBell from '@/components/NotificationBell';
import SyncIndicator from '@/components/SyncIndicator';

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const active = pathname === item.href || pathname.startsWith(item.href + '/');
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
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
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

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
  const navSectionLabel = user.role === 'teacher' ? 'Teaching' : user.role === 'registrar' ? 'Registrar' : user.role === 'bursar' ? 'Bursar' : 'Principal';

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  function renderNav(onNavigate?: () => void) {
    return (
      <>
        {mainNav.length > 0 && (
          <div className="mb-4">
            <p className="px-5 mb-2 text-xs font-semibold text-white/40 uppercase tracking-widest">
              {navSectionLabel}
            </p>
            {mainNav.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </div>
        )}

        {showSettings && (
          <div>
            <p className="px-5 mb-2 text-xs font-semibold text-white/40 uppercase tracking-widest">
              Settings
            </p>
            {SETTINGS_NAV.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-60 md:shrink-0 bg-gradient-to-b from-[#003366] to-[#002244] flex-col">
        <div className="px-5 py-5 border-b border-white/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" className="h-9 w-auto mb-1.5" />
          <p className="text-xs text-white/50 truncate">{user.email}</p>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">{renderNav()}</nav>

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

      {/* Mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40 animate-fade-in"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 w-64 bg-gradient-to-b from-[#003366] to-[#002244] flex flex-col shadow-lift animate-slide-in-right">
            <div className="px-5 py-5 border-b border-white/10 flex items-start justify-between">
              <div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" className="h-9 w-auto mb-1.5" />
                <p className="text-xs text-white/50 truncate">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setNavOpen(false)}
                aria-label="Close menu"
                className="text-white/70 hover:text-white p-1 -mr-1"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.293 4.293a1 1 0 011.414 0L10 7.586l3.293-3.293a1 1 0 111.414 1.414L11.414 9l3.293 3.293a1 1 0 01-1.414 1.414L10 10.414l-3.293 3.293a1 1 0 01-1.414-1.414L8.586 9 5.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

            <nav className="flex-1 py-4 overflow-y-auto">{renderNav(() => setNavOpen(false))}</nav>

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
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="shrink-0 bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              className="md:hidden -ml-1 p-1.5 text-gray-500 hover:text-gray-700"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
              </svg>
            </button>
            <p className="text-sm text-gray-500 capitalize truncate">{user.role.replace('_', ' ')}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <SyncIndicator variant="dark" />
            <NotificationBell variant="dark" />
          </div>
        </header>
        <main key={pathname} className="flex-1 min-w-0 overflow-y-auto page-transition">{children}</main>
      </div>
    </div>
  );
}
