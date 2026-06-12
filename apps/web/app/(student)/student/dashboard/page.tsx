'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DashboardAcademic {
  overall_average: number;
  position: number;
  total_students: number;
  subjects_scored: number;
  total_subjects: number;
}

interface DashboardSubject {
  subject_id: string;
  subject_name: string;
  total_score: number | null;
  grade: string | null;
}

interface DashboardAttendance {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

interface DashboardStudent {
  first_name: string;
  last_name: string;
  admission_no: string;
  class_name: string | null;
}

interface DashboardData {
  student: DashboardStudent;
  term: { id: string; name: string | null };
  academic: DashboardAcademic | null;
  subjects: DashboardSubject[];
  attendance: DashboardAttendance;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentDashboardPage() {
  const { schoolId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: DashboardData }>(`/api/schools/${schoolId}/student/dashboard`)
      .then(res => {
        if (cancelled) return;
        setData(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <p className="text-sm text-gray-500 py-10 text-center">Loading dashboard…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          {data.student.first_name} {data.student.last_name}
        </h1>
        <p className="text-sm text-gray-500">
          {data.student.class_name ?? 'No class assigned'} · {data.student.admission_no}
          {data.term.name ? ` · ${data.term.name}` : ''}
        </p>
      </div>

      {/* Academic Overview */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Academic Overview</h2>
        {data.academic ? (
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-2xl font-bold text-[#003366]">{data.academic.overall_average}</p>
              <p className="text-xs text-gray-500 mt-1">Average</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-[#003366]">
                {data.academic.position}<span className="text-sm font-normal text-gray-400">/{data.academic.total_students}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">Position</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-[#003366]">
                {data.academic.subjects_scored}<span className="text-sm font-normal text-gray-400">/{data.academic.total_subjects}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">Subjects scored</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No results have been recorded for this term yet.</p>
        )}
      </div>

      {/* Attendance */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Attendance</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-2xl font-bold text-[#2472B4]">{data.attendance.percentage}%</p>
            <p className="text-xs text-gray-500 mt-1">Term attendance rate</p>
          </div>
          <div className="text-right text-xs text-gray-500 space-y-0.5">
            <p>Present: <span className="font-medium text-gray-700">{data.attendance.present}</span></p>
            <p>Absent: <span className="font-medium text-gray-700">{data.attendance.absent}</span></p>
            <p>Late: <span className="font-medium text-gray-700">{data.attendance.late}</span></p>
            <p>Excused: <span className="font-medium text-gray-700">{data.attendance.excused}</span></p>
          </div>
        </div>
      </div>

      {/* Subjects */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">Subjects</h2>
          <Link href="/student/results" className="text-xs font-medium text-[#2472B4] hover:underline">
            View all
          </Link>
        </div>
        {data.subjects.length === 0 ? (
          <p className="text-sm text-gray-500">No subject results available yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {data.subjects.map(s => (
              <div key={s.subject_id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-gray-700">{s.subject_name}</span>
                <span className="text-gray-900 font-medium">
                  {s.total_score !== null ? s.total_score : '—'}
                  {s.grade ? <span className="ml-2 text-xs text-gray-500">({s.grade})</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
