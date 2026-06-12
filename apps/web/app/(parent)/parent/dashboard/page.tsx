'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { useParentContext } from '@/lib/parentContext';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SnapshotAcademic {
  overall_average: number;
  position: number;
  total_students: number;
  subjects_scored: number;
  total_subjects: number;
}

interface SnapshotRecentResult {
  subject_id: string;
  subject_name: string;
  total_score: number | null;
  grade: string | null;
}

interface SnapshotAttendance {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

interface Snapshot {
  term_id: string;
  academic: SnapshotAcademic | null;
  recent_results: SnapshotRecentResult[];
  attendance: SnapshotAttendance;
  result_status: string | null;
  report_card_available: boolean;
}

interface BehaviourSummary {
  term_name: string | null;
  incident_count: number;
}

interface FeeInvoiceSummary {
  balance: number;
  status: 'unpaid' | 'partial' | 'paid';
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ParentDashboardPage() {
  const { schoolId } = useAuth();
  const { selectedChild, loading: childrenLoading, error: childrenError, children: linkedChildren } = useParentContext();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [behaviour, setBehaviour] = useState<BehaviourSummary | null>(null);
  const [feeInvoice, setFeeInvoice] = useState<FeeInvoiceSummary | null>(null);

  useEffect(() => {
    if (!schoolId || !selectedChild) return;
    let cancelled = false;
    apiFetch<{ success: boolean; data: BehaviourSummary }>(
      `/api/schools/${schoolId}/behaviour/students/${selectedChild.student_id}/summary`
    )
      .then(({ data }) => { if (!cancelled) setBehaviour(data); })
      .catch(() => { /* non-critical — card is omitted on failure */ });
    return () => { cancelled = true; };
  }, [schoolId, selectedChild]);

  useEffect(() => {
    if (!schoolId || !selectedChild) return;
    let cancelled = false;
    apiFetch<{ success: boolean; data: { term: { id: string } | null } }>(`/api/schools/${schoolId}/current-context`)
      .then(({ data }) => {
        const termId = data.term?.id;
        if (!termId) return null;
        return apiFetch<{ success: boolean; data: FeeInvoiceSummary }>(
          `/api/schools/${schoolId}/fee-invoices/student/${selectedChild.student_id}?term_id=${termId}`
        );
      })
      .then(res => { if (!cancelled && res) setFeeInvoice(res.data); })
      .catch(() => { /* no invoice yet — card shows a fallback message */ });
    return () => { cancelled = true; };
  }, [schoolId, selectedChild]);

  useEffect(() => {
    if (!schoolId || !selectedChild) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: { term: { id: string } | null } }>(`/api/schools/${schoolId}/current-context`)
      .then(({ data }) => {
        if (cancelled) return;
        const termId = data.term?.id;
        if (!termId) {
          setError('No active term has been set up yet.');
          return null;
        }
        return apiFetch<{ success: boolean; data: Snapshot }>(
          `/api/schools/${schoolId}/parent/students/${selectedChild.student_id}/snapshot?term_id=${termId}`
        );
      })
      .then(res => {
        if (cancelled || !res) return;
        setSnapshot(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId, selectedChild]);

  if (childrenLoading) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (childrenError) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{childrenError}</div>
      </div>
    );
  }

  if (linkedChildren.length === 0 || !selectedChild) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No students are linked to your account yet. Please contact your school&apos;s administration.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          {selectedChild.first_name} {selectedChild.last_name}
        </h1>
        <p className="text-sm text-gray-500">
          {selectedChild.class_name ?? 'No class assigned'} · {selectedChild.admission_no}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading dashboard…</p>
      ) : snapshot && (
        <>
          {/* Academic Snapshot */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Academic Snapshot</h2>
            {snapshot.academic ? (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-2xl font-bold text-[#003366]">{snapshot.academic.overall_average}</p>
                  <p className="text-xs text-gray-500 mt-1">Average</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[#003366]">
                    {snapshot.academic.position}<span className="text-sm font-normal text-gray-400">/{snapshot.academic.total_students}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Position</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[#003366]">
                    {snapshot.academic.subjects_scored}<span className="text-sm font-normal text-gray-400">/{snapshot.academic.total_subjects}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Subjects scored</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No results have been recorded for this term yet.</p>
            )}
          </div>

          {/* Behaviour */}
          {behaviour && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">Behaviour</h2>
              {behaviour.incident_count === 0 ? (
                <p className="text-sm text-gray-500">No incidents recorded this term.</p>
              ) : (
                <p className="text-sm text-gray-700">
                  <span className="text-2xl font-bold text-[#003366] mr-2">{behaviour.incident_count}</span>
                  incident{behaviour.incident_count === 1 ? '' : 's'} recorded this term.
                </p>
              )}
            </div>
          )}

          {/* Attendance — always visible */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Attendance</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-[#2472B4]">{snapshot.attendance.percentage}%</p>
                <p className="text-xs text-gray-500 mt-1">Term attendance rate</p>
              </div>
              <div className="text-right text-xs text-gray-500 space-y-0.5">
                <p>Present: <span className="font-medium text-gray-700">{snapshot.attendance.present}</span></p>
                <p>Absent: <span className="font-medium text-gray-700">{snapshot.attendance.absent}</span></p>
                <p>Late: <span className="font-medium text-gray-700">{snapshot.attendance.late}</span></p>
                <p>Excused: <span className="font-medium text-gray-700">{snapshot.attendance.excused}</span></p>
              </div>
            </div>
          </div>

          {/* Recent Results */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Recent Results</h2>
              <Link href="/parent/results" className="text-xs font-medium text-[#2472B4] hover:underline">
                View all
              </Link>
            </div>
            {snapshot.recent_results.length === 0 ? (
              <p className="text-sm text-gray-500">No subject results available yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {snapshot.recent_results.map(r => (
                  <div key={r.subject_id} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-gray-700">{r.subject_name}</span>
                    <span className="text-gray-900 font-medium">
                      {r.total_score !== null ? r.total_score : '—'}
                      {r.grade ? <span className="ml-2 text-xs text-gray-500">({r.grade})</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Fee Balance */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Fee Balance</h2>
            {feeInvoice ? (
              <>
                <p className="text-2xl font-bold text-[#003366] mb-1">
                  ₦{Number(feeInvoice.balance).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs text-gray-500 mb-4">
                  {feeInvoice.status === 'paid' ? 'This term\'s invoice is fully paid.' : 'Outstanding balance for this term.'}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500 mb-4">No fee invoice has been generated for this term yet.</p>
            )}
            <Link
              href="/parent/fees"
              className="block w-full text-center px-4 py-2.5 bg-[#003366] text-white text-sm font-medium rounded-lg hover:bg-[#002347]"
            >
              {feeInvoice && Number(feeInvoice.balance) > 0 ? 'Pay Now' : 'View Fees'}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
