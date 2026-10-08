'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

interface SetupItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  href: string;
}

/**
 * The principal's setup checklist: what the school still has to set up, each with the page that
 * does it. Shows nothing once everything is done. A failed load says so, rather than looking like
 * a school with nothing left to do.
 */
export default function SetupChecklist({ schoolId }: { schoolId: string }) {
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<{ success: boolean; data: { items: SetupItem[] } }>(`/api/schools/${schoolId}/setup-status`)
      .then(({ data }) => setItems(data.items))
      .catch(() => setFailed(true));
  }, [schoolId]);

  if (failed) {
    return (
      <div className="card p-4 mb-8 text-sm text-gray-500">
        The setup checklist could not be loaded. Refresh the page to try again.
      </div>
    );
  }
  if (!items) return null;

  const missing = items.filter(i => !i.done);
  if (missing.length === 0) return null;

  return (
    <div className="card p-6 mb-8 border-amber-200">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-base font-semibold text-gray-900">Finish setting up your school</h2>
        <span className="text-xs text-gray-500">{items.length - missing.length} of {items.length} done</span>
      </div>
      <p className="text-sm text-gray-500 mb-4">Each item below is something staff, parents or students will run into until it is set.</p>
      <ul className="divide-y divide-gray-100">
        {missing.map(item => (
          <li key={item.key} className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-900">{item.label}</p>
              <p className="text-sm text-gray-500">{item.detail}</p>
            </div>
            <Link href={item.href} className="shrink-0 text-sm font-medium text-slate-700 hover:text-slate-900 border border-slate-200 rounded-md px-3 py-1.5 hover:bg-slate-50">
              Set up
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
