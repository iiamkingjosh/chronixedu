'use client';

import Link from 'next/link';
import { SETTINGS_NAV_GROUPS, visibleNavGroups } from '@/lib/navigation';

/**
 * What each settings screen is for, in one line each, grouped. This replaced a silent
 * redirect to School Identity: a principal who opens Settings once a term should not land
 * on the logo uploader.
 */
export default function SettingsIndexPage() {
  const groups = visibleNavGroups(SETTINGS_NAV_GROUPS, []);

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Set up once, adjust rarely. Day-to-day work is in the sidebar.</p>

      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.label}>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">{group.label}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="card p-4 block hover:border-gray-300 hover:shadow-sm transition-colors duration-200"
                >
                  <p className="text-sm font-medium text-gray-900">{item.label}</p>
                  {item.description && <p className="mt-1 text-sm text-gray-500">{item.description}</p>}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
