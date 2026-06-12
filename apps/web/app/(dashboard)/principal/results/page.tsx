'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubjectStatusInfo {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  teacher_id: string;
  teacher_name: string;
  total_students: number;
  fully_scored_students: number;
  completion_pct: number;
  is_complete: boolean;
}

interface ClassStatusSummary {
  draft: number;
  submitted: number;
  approved: number;
  published: number;
}

interface ClassDashboardEntry {
  class_id: string;
  class_name: string;
  class_level: string;
  total_students: number;
  subjects: SubjectStatusInfo[];
  status_summary: ClassStatusSummary;
  all_subjects_complete: boolean;
  can_approve: boolean;
  can_publish: boolean;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

// ── Toast & Modal ─────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ── Two-step confirmation modal ───────────────────────────────────────────────
// Both steps require an explicit click; the action handler (and thus the API
// call) only fires from the second step's confirm button.

function TwoStepConfirmModal({
  title,
  steps,
  confirmLabel,
  confirming,
  onConfirm,
  onClose,
}: {
  title: string;
  steps: [{ heading: string; body: React.ReactNode }, { heading: string; body: React.ReactNode }];
  confirmLabel: string;
  confirming: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<0 | 1>(0);
  const current = steps[step];

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className={step === 0 ? 'text-slate-800' : 'text-gray-400'}>Step 1 of 2</span>
          <span className="text-gray-300">→</span>
          <span className={step === 1 ? 'text-slate-800' : 'text-gray-400'}>Step 2 of 2</span>
        </div>
        <div>
          <h4 className="text-sm font-semibold text-gray-900 mb-1">{current.heading}</h4>
          <div className="text-sm text-gray-600">{current.body}</div>
        </div>
        <div className="flex justify-end gap-3 pt-2">
          {step === 0 ? (
            <>
              <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={() => setStep(1)} className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700">
                Continue
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setStep(0)} className="px-4 py-2 border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">
                Back
              </button>
              <button
                onClick={onConfirm}
                disabled={confirming}
                className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
              >
                {confirming ? 'Submitting…' : confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────

function badgeClass(tone: 'gray' | 'blue' | 'amber' | 'green' | 'red'): string {
  const tones: Record<string, string> = {
    gray:  'bg-gray-100 text-gray-600 border-gray-200',
    blue:  'bg-blue-50 text-blue-700 border-blue-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    red:   'bg-red-50 text-red-700 border-red-200',
  };
  return `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${tones[tone]}`;
}

function SummaryBadge({ label, count, tone }: { label: string; count: number; tone: 'gray' | 'blue' | 'amber' | 'green' }) {
  return <span className={badgeClass(tone)}>{label}: {count}</span>;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrincipalResultsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [termId, setTermId] = useState<string | null>(null);
  const [termName, setTermName] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<ClassDashboardEntry[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);

  const [approveOpen, setApproveOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [acting, setActing] = useState(false);

  const load = useCallback(() => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: { session: unknown; term: { id: string; name: string } | null } }>(
      `/api/schools/${schoolId}/current-context`
    )
      .then(({ data }) => {
        const term = data.term;
        if (!term) {
          setTermId(null);
          setTermName(null);
          setDashboard([]);
          setSelectedClassId(null);
          return;
        }
        setTermId(term.id);
        setTermName(term.name);
        return apiFetch<{ success: boolean; data: ClassDashboardEntry[] }>(
          `/api/schools/${schoolId}/results/approval-dashboard?term_id=${term.id}`
        ).then(({ data: rows }) => {
          setDashboard(rows);
          setSelectedClassId(prev => (prev && rows.some(r => r.class_id === prev) ? prev : (rows[0]?.class_id ?? null)));
        });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load the approval dashboard'))
      .finally(() => setLoading(false));
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  const selectedClass = dashboard.find(c => c.class_id === selectedClassId) ?? null;

  async function handleApprove() {
    if (!schoolId || !selectedClass || !termId) return;
    setActing(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { approved_students: number; message: string } }>(
        `/api/schools/${schoolId}/results/approve`,
        { method: 'POST', body: JSON.stringify({ class_id: selectedClass.class_id, term_id: termId }) }
      );
      show(res.data.message);
      setApproveOpen(false);
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to approve results', 'error');
    } finally {
      setActing(false);
    }
  }

  async function handlePublish() {
    if (!schoolId || !selectedClass || !termId) return;
    setActing(true);
    try {
      const res = await apiFetch<{ success: boolean; data: { published_students: number; message: string } }>(
        `/api/schools/${schoolId}/results/publish`,
        { method: 'POST', body: JSON.stringify({ class_id: selectedClass.class_id, term_id: termId }) }
      );
      show(res.data.message);
      setPublishOpen(false);
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to publish results', 'error');
    } finally {
      setActing(false);
    }
  }

  if (!schoolId || loading) {
    return <div className="max-w-5xl mx-auto p-8"><p className="text-sm text-gray-500">Loading approval dashboard…</p></div>;
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Result Approval</h1>
      <p className="text-sm text-gray-500 mb-6">
        Review subject completion, approve submitted results, and publish them to parents and students.
        {termName && <> Currently viewing <span className="font-medium text-gray-700">{termName}</span>.</>}
      </p>

      {!termId || dashboard.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          {!termId
            ? 'No active term is set for this school yet.'
            : 'No classes have teacher assignments for the current term yet.'}
        </div>
      ) : (
        <>
          <div className="mb-6 max-w-xs">
            <label className="block text-sm font-medium text-gray-700 mb-1">Class</label>
            <select
              value={selectedClassId ?? ''}
              onChange={e => setSelectedClassId(e.target.value || null)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {dashboard.map(c => (
                <option key={c.class_id} value={c.class_id}>{c.class_name} ({c.class_level}) — {c.total_students} students</option>
              ))}
            </select>
          </div>

          {selectedClass && (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">{selectedClass.class_name} ({selectedClass.class_level})</h2>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <SummaryBadge label="Draft" count={selectedClass.status_summary.draft} tone="gray" />
                    <SummaryBadge label="Submitted" count={selectedClass.status_summary.submitted} tone="blue" />
                    <SummaryBadge label="Approved" count={selectedClass.status_summary.approved} tone="amber" />
                    <SummaryBadge label="Published" count={selectedClass.status_summary.published} tone="green" />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setApproveOpen(true)}
                    disabled={!selectedClass.can_approve}
                    title={!selectedClass.can_approve ? 'All subjects must be submitted before results can be approved' : undefined}
                    className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Approve results
                  </button>
                  <button
                    onClick={() => setPublishOpen(true)}
                    disabled={!selectedClass.can_publish}
                    title={!selectedClass.can_publish ? 'Results must be approved before they can be published' : undefined}
                    className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Publish results
                  </button>
                </div>
              </div>

              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-5 py-2.5 font-medium">Subject</th>
                    <th className="text-left px-5 py-2.5 font-medium">Teacher</th>
                    <th className="text-left px-5 py-2.5 font-medium">Scored</th>
                    <th className="text-left px-5 py-2.5 font-medium">Completion</th>
                    <th className="text-left px-5 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {selectedClass.subjects.map(subject => (
                    <tr key={subject.subject_id}>
                      <td className="px-5 py-3 text-gray-900 font-medium">
                        {subject.subject_name} <span className="text-gray-400 font-normal">({subject.subject_code})</span>
                      </td>
                      <td className="px-5 py-3 text-gray-600">{subject.teacher_name}</td>
                      <td className="px-5 py-3 text-gray-600">{subject.fully_scored_students} / {subject.total_students}</td>
                      <td className="px-5 py-3 text-gray-600">{Number(subject.completion_pct)}%</td>
                      <td className="px-5 py-3">
                        {subject.is_complete
                          ? <span className={badgeClass('green')}>Complete</span>
                          : <span className={badgeClass('amber')}>Incomplete</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {approveOpen && selectedClass && (
        <TwoStepConfirmModal
          title="Approve results"
          confirmLabel="Approve results"
          confirming={acting}
          onClose={() => setApproveOpen(false)}
          onConfirm={handleApprove}
          steps={[
            {
              heading: `Approve results for ${selectedClass.class_name}?`,
              body: (
                <p>
                  All {selectedClass.subjects.length} subject(s) for this class have been submitted.
                  Approving will move {selectedClass.status_summary.submitted} student result(s) from
                  <span className="font-medium"> submitted</span> to <span className="font-medium">approved</span>,
                  and unlock report card generation and publishing.
                </p>
              ),
            },
            {
              heading: 'Confirm approval',
              body: (
                <p>
                  This is your final confirmation. Click <span className="font-medium">Approve results</span> to
                  approve results for <span className="font-medium">{selectedClass.class_name}</span>. Approved
                  results can still be returned to teachers if a correction is needed.
                </p>
              ),
            },
          ]}
        />
      )}

      {publishOpen && selectedClass && (
        <TwoStepConfirmModal
          title="Publish results"
          confirmLabel="Publish results"
          confirming={acting}
          onClose={() => setPublishOpen(false)}
          onConfirm={handlePublish}
          steps={[
            {
              heading: `Publish results for ${selectedClass.class_name}?`,
              body: (
                <p>
                  This will make {selectedClass.status_summary.approved} approved result(s) visible to parents
                  and students, and queue a parent notification for each student. Published results
                  <span className="font-medium"> cannot be returned to draft</span>.
                </p>
              ),
            },
            {
              heading: 'Confirm publish',
              body: (
                <p>
                  This is your final confirmation — publishing is permanent. Click{' '}
                  <span className="font-medium">Publish results</span> to publish results for{' '}
                  <span className="font-medium">{selectedClass.class_name}</span>. Parent notifications will be
                  queued, not sent immediately.
                </p>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
