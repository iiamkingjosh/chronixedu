'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Notice {
  id: string;
  class_id: string | null;
  title: string;
  body: string;
  created_at: string;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentNoticesPage() {
  const { schoolId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: Notice[] }>(`/api/schools/${schoolId}/student/notices`)
      .then(({ data }) => {
        if (cancelled) return;
        setNotices(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load notices');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Notices</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading notices…</p>
      ) : notices.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No notices have been posted yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notices.map(notice => (
            <div key={notice.id} className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
              <div className="flex items-start justify-between gap-2 mb-1">
                <h2 className="text-sm font-semibold text-gray-900">{notice.title}</h2>
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  {notice.class_id ? 'Class' : 'School-wide'}
                </span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{notice.body}</p>
              <p className="text-xs text-gray-400 mt-2">
                {new Date(notice.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
