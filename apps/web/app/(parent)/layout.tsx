'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/app/providers';
import { ParentProvider, useParentContext } from '@/lib/parentContext';
import { PARENT_NAV, type NavItem } from '@/lib/navigation';
import NotificationBell from '@/components/NotificationBell';
import SyncIndicator from '@/components/SyncIndicator';

function ChildSelector() {
  const { children, selectedChild, setSelectedChildId, loading } = useParentContext();

  if (loading || children.length <= 1) return null;

  return (
    <div>
      <label className="block mb-1.5 text-xs font-semibold text-white/40 uppercase tracking-widest">
        Viewing
      </label>
      <select
        value={selectedChild?.student_id ?? ''}
        onChange={e => setSelectedChildId(e.target.value)}
        className="w-full border border-white/10 bg-white/5 rounded-md px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-[#2472B4] transition-colors duration-200"
      >
        {children.map(c => (
          <option key={c.student_id} value={c.student_id} className="text-gray-900">
            {c.first_name} {c.last_name}{c.class_name ? ` — ${c.class_name}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

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

function ParentChrome({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <aside className="w-60 shrink-0 bg-gradient-to-b from-[#003366] to-[#002244] flex flex-col">
        <div className="px-5 py-5 border-b border-white/10 space-y-3">
          <div>
            <p className="font-heading text-lg font-semibold text-white">Chronix Edu</p>
            <p className="text-xs text-white/50 mt-0.5">Parent Portal</p>
          </div>
          <ChildSelector />
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">
          {PARENT_NAV.map(item => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
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
          <p className="text-sm text-gray-500">Parent</p>
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

export default function ParentLayout({ children }: { children: React.ReactNode }) {
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

  return (
    <ParentProvider>
      <ParentChrome>{children}</ParentChrome>
    </ParentProvider>
  );
}
