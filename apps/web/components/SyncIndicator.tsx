'use client';

import { useSyncStatus } from '@/lib/syncStatus';

const DOT_COLOR: Record<string, string> = {
  online: 'bg-green-500',
  syncing: 'bg-amber-400 animate-pulse',
  offline: 'bg-red-500',
};

export default function SyncIndicator({ variant = 'dark' }: { variant?: 'light' | 'dark' }) {
  const { status, pendingCount } = useSyncStatus();

  let label: string;
  if (status === 'offline') {
    label = pendingCount > 0 ? `Offline · ${pendingCount} pending` : 'Offline';
  } else if (status === 'syncing') {
    label = 'Syncing…';
  } else {
    label = pendingCount > 0 ? `Synced · ${pendingCount} pending` : 'Synced';
  }

  const textColor = variant === 'light' ? 'text-white/80' : 'text-gray-500';

  return (
    <div className={`flex items-center gap-1.5 px-2 text-xs font-medium ${textColor}`} title={label}>
      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${DOT_COLOR[status]}`} />
      <span className="hidden sm:inline whitespace-nowrap">{label}</span>
    </div>
  );
}
