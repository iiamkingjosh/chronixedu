'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { supabase } from '@/lib/supabaseClient';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationPayload {
  thread_id?: string;
  [key: string]: unknown;
}

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  payload: NotificationPayload | null;
  is_read: boolean;
  created_at: string;
}


const MESSAGES_PATH_BY_ROLE: Record<string, string> = {
  parent: '/parent/messages',
  teacher: '/teacher/messages',
  principal: '/principal/messages',
  super_admin: '/principal/messages',
  student: '/student/messages',
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function NotificationModal({
  notification,
  onClose,
  onViewThread,
}: {
  notification: NotificationItem;
  onClose: () => void;
  onViewThread?: () => void;
}) {
  const hasThread = notification.type === 'message' && !!notification.payload?.thread_id;

  return (
    <div
      className="modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="modal-panel w-full max-w-md bg-white rounded-xl shadow-lg text-gray-900"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <h2 className="font-heading text-base font-semibold text-gray-900">{notification.title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 -mt-1 -mr-1 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors duration-200"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">
          {notification.body ? (
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{notification.body}</p>
          ) : (
            <p className="text-sm text-gray-400">No additional details.</p>
          )}
          <p className="text-xs text-gray-400 mt-4">{formatTimestamp(notification.created_at)}</p>
        </div>
        {hasThread && (
          <div className="px-5 py-4 border-t border-gray-100">
            <button
              type="button"
              onClick={onViewThread}
              className="btn-primary"
            >
              View conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NotificationBell({ variant = 'dark' }: { variant?: 'light' | 'dark' }) {
  const { user, schoolId } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [selectedNotification, setSelectedNotification] = useState<NotificationItem | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: { notifications: NotificationItem[]; unread_count: number } }>(
      `/api/schools/${schoolId}/notifications`
    )
      .then(({ data }) => {
        setNotifications(data.notifications);
        setUnreadCount(data.unread_count);
      })
      .catch(() => {});
  }, [schoolId]);

  // Initial load
  useEffect(() => { load(); }, [load]);

  // Supabase Realtime — subscribe to new notifications for this user.
  // Requires NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  // in apps/web/.env.local (values from Supabase project settings → API).
  // If the notifications table has RLS enabled, add a SELECT policy:
  //   USING (user_id::text = current_setting('request.jwt.claims', true)::json->>'sub')
  useEffect(() => {
    if (!user?.user_id || !schoolId) return;

    const channel = supabase
      .channel(`notifications:${user.user_id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.user_id}`,
        },
        (payload) => {
          const n = payload.new as NotificationItem;
          setNotifications(prev => [n, ...prev]);
          setUnreadCount(c => c + 1);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.user_id, schoolId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function handleMarkAllRead() {
    if (!schoolId) return;
    try {
      await apiFetch(`/api/schools/${schoolId}/notifications/read-all`, { method: 'PATCH' });
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch {
      // non-critical
    }
  }

  async function handleClickNotification(n: NotificationItem) {
    if (!schoolId) return;
    if (!n.is_read) {
      try {
        await apiFetch(`/api/schools/${schoolId}/notifications/${n.id}/read`, { method: 'PATCH' });
        setNotifications(prev => prev.map(x => (x.id === n.id ? { ...x, is_read: true } : x)));
        setUnreadCount(c => Math.max(0, c - 1));
      } catch {
        // non-critical
      }
    }
    setOpen(false);
    setSelectedNotification({ ...n, is_read: true });
  }

  function handleViewThread() {
    if (!selectedNotification || !user) return;
    const threadId = selectedNotification.payload?.thread_id;
    if (threadId) {
      const path = MESSAGES_PATH_BY_ROLE[user.role] ?? '/parent/messages';
      router.push(`${path}?thread=${threadId}`);
    }
    setSelectedNotification(null);
  }

  const iconColor = variant === 'light' ? 'text-white' : 'text-gray-500';
  const iconHover = variant === 'light' ? 'hover:bg-white/10' : 'hover:bg-gray-100';

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`relative p-2 rounded-full transition-colors ${iconHover}`}
        aria-label="Notifications"
      >
        <svg className={`h-5 w-5 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-[#FF761B] text-white text-[10px] font-semibold leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="animate-fade-in absolute right-0 mt-2 w-80 max-w-[90vw] bg-white border border-gray-200 rounded-xl shadow-lg z-50 text-gray-900">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <p className="font-heading text-sm font-semibold text-gray-900">Notifications</p>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs font-medium text-[#2472B4] hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto divide-y divide-gray-100">
            {notifications.length === 0 ? (
              <p className="text-sm text-gray-500 px-4 py-6 text-center">No notifications yet.</p>
            ) : (
              notifications.map(n => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleClickNotification(n)}
                  className={`table-row-hover w-full text-left px-4 py-3 ${n.is_read ? '' : 'bg-blue-50/50'}`}
                >
                  <div className="flex items-start gap-2">
                    {!n.is_read && <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[#2472B4] shrink-0" />}
                    <div className={n.is_read ? 'pl-3.5' : ''}>
                      <p className="text-sm font-medium text-gray-900">{n.title}</p>
                      {n.body && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</p>}
                      <p className="text-[11px] text-gray-400 mt-1">{timeAgo(n.created_at)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {selectedNotification && (
        <NotificationModal
          notification={selectedNotification}
          onClose={() => setSelectedNotification(null)}
          onViewThread={handleViewThread}
        />
      )}
    </div>
  );
}
