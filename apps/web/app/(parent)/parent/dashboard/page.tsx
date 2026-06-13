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

// ── Stat card ─────────────────────────────────────────────────────────────────

type StatTone = 'default' | 'green' | 'amber' | 'red';

const TONE_CLASSES: Record<StatTone, { card: string; value: string }> = {
  default: { card: 'bg-white border-gray-200', value: 'text-[#003366]' },
  green:   { card: 'bg-green-50 border-green-200', value: 'text-green-700' },
  amber:   { card: 'bg-amber-50 border-amber-200', value: 'text-amber-700' },
  red:     { card: 'bg-red-50 border-red-200', value: 'text-red-700' },
};

function attendanceTone(percentage: number): StatTone {
  if (percentage > 80) return 'green';
  if (percentage >= 60) return 'amber';
  return 'red';
}

function StatCard({ label, value, sub, tone = 'default' }: { label: string; value: string | number; sub?: string; tone?: StatTone }) {
  const t = TONE_CLASSES[tone];
  return (
    <div className={`card card-hover border p-5 ${t.card}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`stat-value mt-2 text-3xl font-semibold font-heading ${t.value}`}>{value}</p>
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
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <div>
          <div className="skeleton h-7 w-40" />
          <div className="skeleton h-4 w-72 mt-2" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (childrenError) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{childrenError}</div>
      </div>
    );
  }

  if (linkedChildren.length === 0 || !selectedChild) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No students are linked to your account yet. Please contact your school&apos;s administration.
        </div>
      </div>
    );
  }

  const academic = snapshot?.academic ?? null;
  const attendancePct = snapshot?.attendance.percentage ?? 0;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Welcome back</h1>
        <p className="mt-1 text-sm text-gray-500">
          Here&apos;s how <span className="font-medium text-gray-700">{selectedChild.first_name} {selectedChild.last_name}</span> is doing in{' '}
          <span className="font-medium text-gray-700">{selectedChild.class_name ?? 'their class'}</span> · {selectedChild.admission_no}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
        </div>
      ) : snapshot && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Overall Average"
              value={academic ? academic.overall_average : '—'}
              sub={academic ? `${academic.subjects_scored}/${academic.total_subjects} subjects scored` : 'No results yet'}
            />
            <StatCard
              label="Class Position"
              value={academic ? `${academic.position}/${academic.total_students}` : '—'}
              sub="Current term"
            />
            <StatCard
              label="Attendance"
              value={`${attendancePct}%`}
              sub="Term attendance rate"
              tone={attendanceTone(attendancePct)}
            />
            <StatCard
              label="Fee Balance"
              value={feeInvoice ? `₦${Number(feeInvoice.balance).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
              sub={feeInvoice ? (feeInvoice.status === 'paid' ? 'Fully paid' : 'Outstanding for this term') : 'No invoice yet'}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Recent Results */}
            <div className="card p-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-gray-900">Recent Results</h2>
                <Link href="/parent/results" className="text-xs font-medium text-[#2472B4] hover:underline">
                  View all
                </Link>
              </div>
              {snapshot.recent_results.length === 0 ? (
                <p className="text-sm text-gray-500">No subject results available yet.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {snapshot.recent_results.map(r => (
                    <div key={r.subject_id} className="table-row-hover -mx-2 px-2 flex items-center justify-between py-2 text-sm rounded-md">
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

            {/* Attendance breakdown + Behaviour */}
            <div className="space-y-4">
              <div className="card p-6">
                <h2 className="text-base font-semibold text-gray-900 mb-3">Attendance Breakdown</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <p>Present: <span className="font-medium text-gray-700">{snapshot.attendance.present}</span></p>
                  <p>Absent: <span className="font-medium text-gray-700">{snapshot.attendance.absent}</span></p>
                  <p>Late: <span className="font-medium text-gray-700">{snapshot.attendance.late}</span></p>
                  <p>Excused: <span className="font-medium text-gray-700">{snapshot.attendance.excused}</span></p>
                </div>
                <Link href="/parent/attendance" className="mt-3 inline-block text-xs font-medium text-[#2472B4] hover:underline">
                  View full attendance
                </Link>
              </div>

              {behaviour && (
                <div className="card p-6">
                  <h2 className="text-base font-semibold text-gray-900 mb-3">Behaviour</h2>
                  {behaviour.incident_count === 0 ? (
                    <p className="text-sm text-gray-500">No incidents recorded this term.</p>
                  ) : (
                    <p className="text-sm text-gray-700">
                      <span className="font-heading text-2xl font-bold text-[#003366] mr-2">{behaviour.incident_count}</span>
                      incident{behaviour.incident_count === 1 ? '' : 's'} recorded this term.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Fees CTA */}
          <div className="card p-6 flex items-center justify-between flex-wrap gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Fees</h2>
              <p className="mt-1 text-sm text-gray-500">
                {feeInvoice
                  ? feeInvoice.status === 'paid'
                    ? 'This term\'s invoice is fully paid.'
                    : 'You have an outstanding balance for this term.'
                  : 'No fee invoice has been generated for this term yet.'}
              </p>
            </div>
            <Link href="/parent/fees" className="btn-primary">
              {feeInvoice && Number(feeInvoice.balance) > 0 ? 'Pay Now' : 'View Fees'}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
