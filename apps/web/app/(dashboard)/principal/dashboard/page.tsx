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

type StatAccent = 'navy' | 'orange' | 'blue';

const ACCENT_CLASSES: Record<StatAccent, string> = {
  navy: 'text-[#003366]',
  orange: 'text-[#FF761B]',
  blue: 'text-[#2472B4]',
};

function StatCard({ label, value, sub, accent = 'navy' }: { label: string; value: string | number; sub?: string; accent?: StatAccent }) {
  return (
    <div className="card card-hover p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`stat-value mt-2 text-3xl font-semibold font-heading ${ACCENT_CLASSES[accent]}`}>{value}</p>
      {sub && <p className="mt-1 text-sm text-gray-500">{sub}</p>}
    </div>
  );
}

function StatCardSkeleton() {
  return (
    <div className="card p-5">
      <div className="skeleton h-3 w-20" />
      <div className="skeleton h-8 w-16 mt-3" />
      <div className="skeleton h-3 w-24 mt-2" />
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
      <div className="p-8 max-w-5xl">
        <div className="mb-8">
          <div className="skeleton h-7 w-64" />
          <div className="skeleton h-4 w-40 mt-2" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
        </div>
        <div className="card p-6">
          <div className="skeleton h-4 w-28 mb-4" />
          <div className="flex gap-3">
            <div className="skeleton h-9 w-32" />
            <div className="skeleton h-9 w-32" />
          </div>
        </div>
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
        <StatCard label="Students" value={overview.total_students} accent="navy" />
        <StatCard label="Teachers" value={overview.total_teachers} accent="blue" />
        <StatCard label="Classes" value={overview.total_classes} accent="orange" />
        <StatCard
          label="School Average"
          value={overview.school_average !== null ? `${overview.school_average}%` : '—'}
          sub={overview.school_average !== null ? 'Current term' : 'No scores yet'}
          accent="navy"
        />
      </div>

      <div className="card p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Quick actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/principal/results" className="btn-primary">
            Review results
          </Link>
          <Link href="/principal/report-cards" className="btn-secondary">
            Report cards
          </Link>
        </div>
      </div>
    </div>
  );
}
