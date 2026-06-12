'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

interface PrincipalOverview {
  greeting: string;
  total_students: number;
  total_teachers: number;
  total_classes: number;
  current_session: string | null;
  current_term: string | null;
  school_average: number | null;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 p-5 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-[#003366]">{value}</p>
      {sub && <p className="mt-1 text-sm text-gray-500">{sub}</p>}
    </div>
  );
}

export default function PrincipalDashboardPage() {
  const { schoolId } = useAuth();
  const [overview, setOverview] = useState<PrincipalOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) {
      setError('No school is associated with your account.');
      setLoading(false);
      return;
    }

    apiFetch<{ success: boolean; data: PrincipalOverview }>(
      `/api/schools/${schoolId}/dashboard/principal/overview`
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

  const termLabel =
    overview.current_session && overview.current_term
      ? `${overview.current_session} · ${overview.current_term}`
      : overview.current_term ?? 'No active term';

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">{overview.greeting}</h1>
        <p className="mt-1 text-sm text-gray-500">{termLabel}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Students" value={overview.total_students} />
        <StatCard label="Teachers" value={overview.total_teachers} />
        <StatCard label="Classes" value={overview.total_classes} />
        <StatCard
          label="School Average"
          value={overview.school_average !== null ? `${overview.school_average}%` : '—'}
          sub={overview.school_average !== null ? 'Current term' : 'No scores yet'}
        />
      </div>

      <div className="rounded-xl bg-white border border-gray-200 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Quick actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/principal/results"
            className="inline-flex items-center rounded-lg bg-[#003366] px-4 py-2 text-sm font-medium text-white hover:bg-[#002244] transition-colors"
          >
            Review results
          </Link>
          <Link
            href="/principal/report-cards"
            className="inline-flex items-center rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Report cards
          </Link>
        </div>
      </div>
    </div>
  );
}
