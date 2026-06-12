'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type TargetRole = 'all' | 'teacher' | 'parent' | 'student';

interface Announcement {
  id: string;
  title: string;
  body: string;
  target_role: TargetRole;
  published_at: string;
  author_first_name: string;
  author_last_name: string;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

const TARGET_OPTIONS: { value: TargetRole; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'teacher', label: 'Teachers' },
  { value: 'parent', label: 'Parents' },
  { value: 'student', label: 'Students' },
];

const TARGET_BADGE: Record<TargetRole, string> = {
  all: 'bg-slate-50 text-slate-700 border-slate-200',
  teacher: 'bg-blue-50 text-blue-700 border-blue-200',
  parent: 'bg-purple-50 text-purple-700 border-purple-200',
  student: 'bg-green-50 text-green-700 border-green-200',
};

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrincipalAnnouncementsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetRole, setTargetRole] = useState<TargetRole>('all');
  const [submitting, setSubmitting] = useState(false);

  function loadAnnouncements() {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: Announcement[] }>(`/api/schools/${schoolId}/announcements`)
      .then(({ data }) => setAnnouncements(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load announcements'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadAnnouncements(); }, [schoolId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !title.trim() || !body.trim()) return;

    setSubmitting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/announcements`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), body: body.trim(), target_role: targetRole }),
      });
      show('Announcement published.');
      setTitle('');
      setBody('');
      setTargetRole('all');
      loadAnnouncements();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to publish announcement', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!schoolId || loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-500">Loading announcements…</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.message}
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Announcements</h1>
        <p className="mt-1 text-sm text-gray-500">Publish a school-wide or role-targeted announcement.</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4 mb-8">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Title</label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Message</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Audience</label>
          <select
            value={targetRole}
            onChange={e => setTargetRole(e.target.value as TargetRole)}
            className="w-full sm:w-64 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            {TARGET_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={submitting || !title.trim() || !body.trim()}
          className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? 'Publishing…' : 'Publish announcement'}
        </button>
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">{error}</div>
      )}

      <div className="rounded-xl bg-white border border-gray-200 shadow-sm">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Recent announcements</h2>
        </div>
        {announcements.length === 0 ? (
          <p className="text-sm text-gray-500 px-6 py-8 text-center">No announcements published yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {announcements.map(a => (
              <div key={a.id} className="px-6 py-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{a.title}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(a.published_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {' · '}
                      {a.author_first_name} {a.author_last_name}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-medium uppercase tracking-wide px-2 py-1 rounded-md border ${TARGET_BADGE[a.target_role]}`}>
                    {a.target_role === 'all' ? 'Everyone' : a.target_role}
                  </span>
                </div>
                <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{a.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
