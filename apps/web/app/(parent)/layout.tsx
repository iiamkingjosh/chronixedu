'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/app/providers';
import { ParentProvider, useParentContext } from '@/lib/parentContext';
import { PARENT_NAV } from '@/lib/navigation';
import NotificationBell from '@/components/NotificationBell';
import SyncIndicator from '@/components/SyncIndicator';

function ChildSelector() {
  const { children, selectedChild, setSelectedChildId, loading } = useParentContext();

  if (loading || children.length <= 1) return null;

  return (
    <div className="bg-white border-b border-gray-200 px-4 py-2.5">
      <select
        value={selectedChild?.student_id ?? ''}
        onChange={e => setSelectedChildId(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#2472B4]"
      >
        {children.map(c => (
          <option key={c.student_id} value={c.student_id}>
            {c.first_name} {c.last_name}{c.class_name ? ` — ${c.class_name}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 flex">
      {PARENT_NAV.map(item => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/');
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 flex flex-col items-center justify-center py-2.5 text-xs font-medium transition-colors ${
              active ? 'text-[#003366]' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            <span className={`mb-1 h-1.5 w-1.5 rounded-full ${active ? 'bg-[#FF761B]' : 'bg-transparent'}`} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ParentChrome({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const router = useRouter();

  function handleLogout() {
    logout();
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="shrink-0 bg-[#003366] text-white px-4 py-3 flex items-center justify-between">
        <p className="text-sm font-semibold">Chronix Edu — Parent</p>
        <div className="flex items-center gap-1">
          <SyncIndicator variant="light" />
          <NotificationBell variant="light" />
          <button
            type="button"
            onClick={handleLogout}
            className="text-xs font-medium text-white/80 hover:text-white px-2"
          >
            Sign out
          </button>
        </div>
      </header>
      <ChildSelector />
      <main className="flex-1 min-w-0 pb-16">{children}</main>
      <BottomNav />
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
