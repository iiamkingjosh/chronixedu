'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/app/providers';
import { SETTINGS_NAV_GROUPS, visibleNavGroups } from '@/lib/navigation';

/**
 * The eleven settings screens, grouped, beside whichever one is open. The sidebar shows a
 * single "Settings" entry; this is where the rest of it lives. Desktop: a rail with group
 * labels. Phone: one scrolling row of the same links, no labels.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { subscriptionTier } = useAuth();
  const groups = visibleNavGroups(SETTINGS_NAV_GROUPS, subscriptionTier === 'basic' ? ['/settings/payout'] : []);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const linkClass = (href: string) =>
    `block rounded-md px-3 py-1.5 text-sm ${isActive(href) ? 'bg-gray-100 font-medium text-gray-900' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`;

  return (
    <div className="flex flex-col md:flex-row min-h-full">
      <nav aria-label="Settings" className="md:w-56 md:shrink-0 border-b md:border-b-0 md:border-r border-gray-200 bg-white">
        {/* Desktop rail */}
        <div className="hidden md:block px-3 py-6">
          <Link href="/settings" className={linkClass('/settings') + (pathname === '/settings' ? '' : ' text-gray-500')}>
            All settings
          </Link>
          {groups.map((group) => (
            <div key={group.label} className="mt-5">
              <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-widest text-gray-400">{group.label}</p>
              {group.items.map((item) => (
                <Link key={item.href} href={item.href} className={linkClass(item.href)}>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
        {/* Phone: one scrolling row */}
        <div className="md:hidden flex gap-1 overflow-x-auto px-3 py-2 whitespace-nowrap">
          <Link href="/settings" className={linkClass('/settings')}>All</Link>
          {groups.flatMap((g) => g.items).map((item) => (
            <Link key={item.href} href={item.href} className={linkClass(item.href)}>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
