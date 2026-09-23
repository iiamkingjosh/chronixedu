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

interface AtRiskStudent {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  class_name: string;
  overall_average: number;
  promotion_cutoff: number;
  deficit: number;
}

interface TeacherActivity {
  teacher_id: string;
  first_name: string;
  last_name: string;
  subjects_assigned: number;
  classes_assigned: number;
  submitted: number;
  pending: number;
  last_score_entry_at: string | null;
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
  const [atRisk, setAtRisk] = useState<AtRiskStudent[]>([]);
  const [teacherActivity, setTeacherActivity] = useState<TeacherActivity[]>([]);
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

    // Secondary panels load independently — a failure here must not blank the
    // whole dashboard, so they fail quietly and simply render nothing.
    apiFetch<{ success: boolean; data: AtRiskStudent[] }>(
      `/api/schools/${schoolId}/dashboard/principal/students-at-risk`
    )
      .then(({ data }) => setAtRisk(data))
      .catch(() => {});

    apiFetch<{ success: boolean; data: TeacherActivity[] }>(
      `/api/schools/${schoolId}/dashboard/principal/teacher-activity`
    )
      .then(({ data }) => setTeacherActivity(data))
      .catch(() => {});
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

      {atRisk.length > 0 && (
        <div className="card p-6 mb-8">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Students at risk</h2>
            <span className="text-xs text-gray-500">
              Below the {atRisk[0].promotion_cutoff}% promotion cut-off
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2 text-left whitespace-nowrap">Student</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Class</th>
                  <th className="px-3 py-2 text-center whitespace-nowrap">Average</th>
                  <th className="px-3 py-2 text-center whitespace-nowrap">Short by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {atRisk.slice(0, 10).map(s => (
                  <tr key={s.student_id}>
                    <td className="px-3 py-2 text-gray-900 whitespace-nowrap">
                      {s.first_name} {s.last_name}
                      <span className="text-gray-400 text-xs ml-2">{s.admission_no}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{s.class_name}</td>
                    <td className="px-3 py-2 text-center font-medium text-gray-900">{s.overall_average}%</td>
                    <td className="px-3 py-2 text-center text-[#FF761B] font-medium">{s.deficit}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {atRisk.length > 10 && (
            <p className="mt-3 text-xs text-gray-500">
              Showing 10 of {atRisk.length} students below the cut-off.
            </p>
          )}
        </div>
      )}

      {teacherActivity.length > 0 && (
        <div className="card p-6 mb-8">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Teacher submission activity</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2 text-left whitespace-nowrap">Teacher</th>
                  <th className="px-3 py-2 text-center whitespace-nowrap">Classes</th>
                  <th className="px-3 py-2 text-center whitespace-nowrap">Submitted</th>
                  <th className="px-3 py-2 text-center whitespace-nowrap">Pending</th>
                  <th className="px-3 py-2 text-left whitespace-nowrap">Last score entry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {teacherActivity.map(t => (
                  <tr key={t.teacher_id}>
                    <td className="px-3 py-2 text-gray-900 whitespace-nowrap">{t.first_name} {t.last_name}</td>
                    <td className="px-3 py-2 text-center text-gray-600">{t.classes_assigned}</td>
                    <td className="px-3 py-2 text-center font-medium text-gray-900">{t.submitted}</td>
                    <td className={`px-3 py-2 text-center font-medium ${t.pending > 0 ? 'text-[#FF761B]' : 'text-gray-400'}`}>
                      {t.pending}
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {t.last_score_entry_at
                        ? new Date(t.last_score_entry_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                        : 'No entries yet'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
