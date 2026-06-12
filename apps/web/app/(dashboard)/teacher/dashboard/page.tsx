'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

interface TeacherOverview {
  teacher_mode: string;
  pending_score_entries: number;
  results_submitted: number;
  results_pending: number;
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 p-5 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p
        className={`mt-2 text-3xl font-semibold ${
          highlight && Number(value) > 0 ? 'text-[#FF761B]' : 'text-[#003366]'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export default function TeacherDashboardPage() {
  const { schoolId } = useAuth();
  const [overview, setOverview] = useState<TeacherOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) {
      setError('No school is associated with your account.');
      setLoading(false);
      return;
    }

    apiFetch<{ success: boolean; data: TeacherOverview }>(
      `/api/schools/${schoolId}/dashboard/teacher/overview`
    )
      .then(({ data }) => setOverview(data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [schoolId]);

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-500">Loading dashboard…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!overview) return null;

  const modeLabel =
    overview.teacher_mode === 'class' ? 'Class teacher' : 'Subject teacher';

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Teacher Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">{modeLabel}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Pending score entries"
          value={overview.pending_score_entries}
          highlight
        />
        <StatCard label="Results submitted" value={overview.results_submitted} />
        <StatCard label="Results pending" value={overview.results_pending} />
      </div>

      <div className="rounded-xl bg-white border border-gray-200 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900 mb-2">Score entry</h2>
        <p className="text-sm text-gray-500 mb-4">
          {overview.pending_score_entries > 0
            ? `You have ${overview.pending_score_entries} score ${overview.pending_score_entries === 1 ? 'entry' : 'entries'} waiting.`
            : 'All assigned scores are up to date for the current term.'}
        </p>
        <Link
          href="/teacher/scores"
          className="inline-flex items-center rounded-lg bg-[#FF761B] px-4 py-2 text-sm font-medium text-white hover:bg-[#e56812] transition-colors"
        >
          Go to score entry
        </Link>
      </div>
    </div>
  );
}
