'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Announcement {
  id: string;
  title: string;
  body: string;
  target_role: string;
  published_at: string;
  author_first_name: string;
  author_last_name: string;
}

// ── Component ─────────────────────────────────────────────────────────────────
// Read-only announcements list — reused by any role that can view but not
// compose announcements (bursar, registrar). The backend already scopes
// results to "all" plus whatever role the caller is, so no target filter
// needs to be passed here.

export default function AnnouncementsView() {
  const { schoolId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: Announcement[] }>(`/api/schools/${schoolId}/announcements`)
      .then(({ data }) => {
        if (cancelled) return;
        setAnnouncements(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load announcements');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Announcements</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading announcements…</p>
      ) : announcements.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No announcements have been posted yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {announcements.map(a => (
            <div key={a.id} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <div className="flex items-start justify-between gap-2 mb-1">
                <h2 className="text-sm font-semibold text-gray-900">{a.title}</h2>
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  {a.target_role === 'all' ? 'School-wide' : a.target_role}
                </span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{a.body}</p>
              <p className="text-xs text-gray-400 mt-2">
                {new Date(a.published_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {' · '}
                {a.author_first_name} {a.author_last_name}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
