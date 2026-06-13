'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { offlineDb } from '@/lib/offlineDb';
import { isNetworkError } from '@/lib/offlineSync';
import { useSyncStatus } from '@/lib/syncStatus';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TeacherOverview {
  teacher_mode: 'class' | 'subject';
  pending_score_entries: number;
  results_submitted: number;
  results_pending: number;
}

interface AssignmentStatus {
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
  students_total: number;
  students_scored: number;
  students_missing: number;
  result_status: 'submitted' | 'draft';
}

interface ComponentInfo {
  id: string;
  config_id: string;
  name: string;
  max_score: number;
  weight_percent: number;
  display_order: number;
}

interface SheetStudent {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  scores: Record<string, { score_id: string; score: number } | null>;
}

interface ClassSheet {
  class_info: { id: string; name: string; level: string; stream: string | null };
  subject_info: { id: string; name: string; code: string };
  term_info: { id: string; name: string };
  components: ComponentInfo[];
  students: SheetStudent[];
}

interface TeacherNotification {
  id: string;
  notification_type: string | null;
  reason: string | null;
  class_id: string | null;
  created_at: string;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Score grid ────────────────────────────────────────────────────────────────

function ScoreGrid({
  schoolId,
  termId,
  classId,
  subjectId,
  isSubmitted,
  submitButtonLabel,
  onSubmitted,
  show,
}: {
  schoolId: string;
  termId: string;
  classId: string;
  subjectId: string;
  isSubmitted: boolean;
  submitButtonLabel: string;
  onSubmitted: () => void;
  show: ToastFn;
}) {
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<ClassSheet | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const { refresh: refreshSyncStatus } = useSyncStatus();

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ class_id: classId, subject_id: subjectId, term_id: termId });
    apiFetch<{ success: boolean; data: ClassSheet }>(
      `/api/schools/${schoolId}/scores/class-sheet?${params.toString()}`
    )
      .then(({ data }) => {
        setSheet(data);
        const initial: Record<string, Record<string, string>> = {};
        for (const student of data.students) {
          initial[student.student_id] = {};
          for (const comp of data.components) {
            const existing = student.scores[comp.id];
            initial[student.student_id][comp.id] = existing ? String(existing.score) : '';
          }
        }
        setEdits(initial);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load score sheet'))
      .finally(() => setLoading(false));
  }, [schoolId, classId, subjectId, termId]);

  useEffect(() => { load(); }, [load]);

  function handleChange(studentId: string, componentId: string, value: string) {
    if (isSubmitted) return;
    setEdits(prev => ({
      ...prev,
      [studentId]: { ...prev[studentId], [componentId]: value },
    }));
  }

  function totalFor(studentId: string): number {
    const row = edits[studentId];
    if (!row) return 0;
    return Object.values(row).reduce((sum, v) => sum + (v === '' ? 0 : Number(v)), 0);
  }

  function buildEntries(): { student_id: string; component_id: string; score: number }[] {
    if (!sheet) return [];
    const entries: { student_id: string; component_id: string; score: number }[] = [];
    for (const student of sheet.students) {
      for (const comp of sheet.components) {
        const raw = edits[student.student_id]?.[comp.id] ?? '';
        if (raw === '') continue;
        entries.push({ student_id: student.student_id, component_id: comp.id, score: Number(raw) });
      }
    }
    return entries;
  }

  async function persistEntries() {
    const entries = buildEntries();
    if (entries.length === 0) return;
    await apiFetch(`/api/schools/${schoolId}/scores/bulk-entry`, {
      method: 'POST',
      body: JSON.stringify({ subject_id: subjectId, class_id: classId, term_id: termId, entries }),
    });
  }

  async function queueScoresOffline() {
    const entries = buildEntries();
    if (entries.length === 0) return false;
    await offlineDb.offline_score_queue.add({
      school_id: schoolId,
      subject_id: subjectId,
      class_id: classId,
      term_id: termId,
      entries,
      queued_at: new Date().toISOString(),
    });
    refreshSyncStatus();
    show('You are offline. Scores saved locally and will sync when you reconnect.');
    return true;
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      if (!navigator.onLine) {
        await queueScoresOffline();
        return;
      }
      await persistEntries();
      show('Scores saved');
      load();
    } catch (err: unknown) {
      if (isNetworkError(err)) {
        await queueScoresOffline();
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to save scores';
      setError(message);
      show(message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError('');
    try {
      if (!navigator.onLine) {
        show('You are offline. Submitting for approval requires an internet connection.', 'error');
        return;
      }
      await persistEntries();
      await apiFetch(`/api/schools/${schoolId}/results/submit`, {
        method: 'POST',
        body: JSON.stringify({ class_id: classId, subject_id: subjectId, term_id: termId }),
      });
      show('Submitted for approval');
      onSubmitted();
      load();
    } catch (err: unknown) {
      const message = isNetworkError(err)
        ? 'You are offline. Submitting for approval requires an internet connection.'
        : err instanceof Error ? err.message : 'Failed to submit for approval';
      setError(message);
      show(message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="overflow-hidden border border-gray-200 rounded-xl">
        <div className="skeleton h-10 w-full rounded-none" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-t border-gray-100">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-4 w-20" />
            <div className="skeleton h-7 w-14 ml-auto" />
            <div className="skeleton h-7 w-14" />
            <div className="skeleton h-7 w-14" />
          </div>
        ))}
      </div>
    );
  }

  if (!sheet) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
        {error || 'No score sheet available for this selection.'}
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-3 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-x-auto border border-gray-200 rounded-xl">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Student</th>
              <th className="px-4 py-3 text-left font-medium">Admission No.</th>
              {sheet.components.map(comp => (
                <th key={comp.id} className="px-3 py-3 text-center font-medium whitespace-nowrap">
                  {comp.name}
                  <span className="block text-[10px] font-normal normal-case text-gray-400">/ {Number(comp.max_score)}</span>
                </th>
              ))}
              <th className="px-4 py-3 text-center font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sheet.students.map(student => (
              <tr key={student.student_id} className="table-row-hover">
                <td className="px-4 py-2.5 whitespace-nowrap text-gray-900">
                  {student.first_name} {student.last_name}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-gray-500">{student.admission_no}</td>
                {sheet.components.map(comp => {
                  const raw = edits[student.student_id]?.[comp.id] ?? '';
                  const numeric = raw === '' ? null : Number(raw);
                  const exceeds = numeric !== null && numeric > Number(comp.max_score);
                  return (
                    <td key={comp.id} className="px-2 py-2 text-center">
                      {isSubmitted ? (
                        <span className={`inline-block w-16 text-center ${exceeds ? 'text-red-600 font-semibold' : 'text-gray-700'}`}>
                          {raw === '' ? '—' : raw}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min={0}
                          value={raw}
                          onChange={e => handleChange(student.student_id, comp.id, e.target.value)}
                          className={`w-16 text-center border rounded-md px-1.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#2472B4] transition-colors duration-200 ${
                            exceeds ? 'border-red-400 bg-red-50 text-red-700' : 'border-gray-300'
                          }`}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="px-4 py-2.5 text-center font-semibold text-gray-900">{totalFor(student.student_id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        {isSubmitted ? (
          <span className="badge-info">
            Submitted — awaiting approval
          </span>
        ) : (
          <span className="text-xs text-gray-400">Cells turn red when a score exceeds the component&rsquo;s maximum.</span>
        )}
        {!isSubmitted && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving || submitting}
              className="btn-secondary"
            >
              {saving ? 'Saving…' : 'Save scores'}
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving || submitting}
              className="btn-primary"
            >
              {submitting ? 'Submitting…' : submitButtonLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Subject mode board ────────────────────────────────────────────────────────

function SubjectModeBoard({
  schoolId,
  termId,
  assignments,
  show,
  onAssignmentsChanged,
}: {
  schoolId: string;
  termId: string;
  assignments: AssignmentStatus[];
  show: ToastFn;
  onAssignmentsChanged: () => void;
}) {
  const subjects = useMemo(() => {
    const map = new Map<string, { subject_id: string; subject_name: string; classes: AssignmentStatus[] }>();
    for (const a of assignments) {
      if (!map.has(a.subject_id)) {
        map.set(a.subject_id, { subject_id: a.subject_id, subject_name: a.subject_name, classes: [] });
      }
      map.get(a.subject_id)!.classes.push(a);
    }
    return [...map.values()];
  }, [assignments]);

  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);

  useEffect(() => {
    if (subjects.length > 0 && !subjects.some(s => s.subject_id === selectedSubjectId)) {
      setSelectedSubjectId(subjects[0].subject_id);
    }
  }, [subjects, selectedSubjectId]);

  const selectedSubject = subjects.find(s => s.subject_id === selectedSubjectId) ?? null;

  useEffect(() => {
    if (selectedSubject && !selectedSubject.classes.some(c => c.class_id === selectedClassId)) {
      setSelectedClassId(selectedSubject.classes[0]?.class_id ?? null);
    }
  }, [selectedSubject, selectedClassId]);

  const selectedClass = selectedSubject?.classes.find(c => c.class_id === selectedClassId) ?? null;

  if (subjects.length === 0) {
    return <p className="text-sm text-gray-500 py-10 text-center">You have no subject assignments for the active term.</p>;
  }

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {subjects.map(subject => {
          const allSubmitted = subject.classes.every(c => c.result_status === 'submitted');
          const noneSubmitted = subject.classes.every(c => c.result_status !== 'submitted');
          const summary = allSubmitted ? 'All submitted' : noneSubmitted ? 'Draft' : 'Partially submitted';
          const summaryClasses = allSubmitted
            ? 'badge-success'
            : noneSubmitted
            ? 'badge-default'
            : 'badge-warning';
          const active = subject.subject_id === selectedSubjectId;
          return (
            <button
              key={subject.subject_id}
              onClick={() => setSelectedSubjectId(subject.subject_id)}
              className={`card card-hover text-left px-4 py-3.5 ${
                active ? 'border-[#2472B4] ring-1 ring-[#2472B4]/30' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-900">{subject.subject_name}</h3>
                <span className={`${summaryClasses} text-[11px] whitespace-nowrap`}>
                  {summary}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-gray-500">{subject.classes.map(c => c.class_name).join(', ')}</p>
            </button>
          );
        })}
      </div>

      {selectedSubject && (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 mb-5">
            {selectedSubject.classes.map(c => {
              const active = c.class_id === selectedClassId;
              return (
                <button
                  key={c.class_id}
                  onClick={() => setSelectedClassId(c.class_id)}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors duration-200 ${
                    active ? 'border-[#2472B4] text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {c.class_name}
                  {c.result_status === 'submitted' && (
                    <span className="badge-info text-[10px] px-1.5 py-0.5">
                      Submitted
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedClass && (
            <ScoreGrid
              key={`${selectedSubject.subject_id}:${selectedClass.class_id}`}
              schoolId={schoolId}
              termId={termId}
              classId={selectedClass.class_id}
              subjectId={selectedSubject.subject_id}
              isSubmitted={selectedClass.result_status === 'submitted'}
              submitButtonLabel={`Submit ${selectedClass.class_name} for approval`}
              onSubmitted={onAssignmentsChanged}
              show={show}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Class mode board ──────────────────────────────────────────────────────────

function ClassModeBoard({
  schoolId,
  termId,
  assignments,
  show,
  onAssignmentsChanged,
}: {
  schoolId: string;
  termId: string;
  assignments: AssignmentStatus[];
  show: ToastFn;
  onAssignmentsChanged: () => void;
}) {
  const classes = useMemo(() => {
    const map = new Map<string, { class_id: string; class_name: string; subjects: AssignmentStatus[] }>();
    for (const a of assignments) {
      if (!map.has(a.class_id)) {
        map.set(a.class_id, { class_id: a.class_id, class_name: a.class_name, subjects: [] });
      }
      map.get(a.class_id)!.subjects.push(a);
    }
    return [...map.values()];
  }, [assignments]);

  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);

  const selectedClass = classes.find(c => c.class_id === selectedClassId) ?? null;
  const selectedSubject = selectedClass?.subjects.find(s => s.subject_id === selectedSubjectId) ?? null;

  if (classes.length === 0) {
    return <p className="text-sm text-gray-500 py-10 text-center">You have no class assignments for the active term.</p>;
  }

  return (
    <div>
      <div className="mb-5">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">1. Select a class</p>
        <div className="flex flex-wrap gap-2">
          {classes.map(c => {
            const active = c.class_id === selectedClassId;
            return (
              <button
                key={c.class_id}
                onClick={() => { setSelectedClassId(c.class_id); setSelectedSubjectId(null); }}
                className={`px-4 py-2 text-sm font-medium rounded-md border transition-colors duration-200 ${
                  active ? 'border-[#2472B4] bg-blue-50 text-[#2472B4]' : 'border-gray-200 text-gray-600 hover:border-[#2472B4]/50'
                }`}
              >
                {c.class_name}
              </button>
            );
          })}
        </div>
      </div>

      {selectedClass && (
        <div className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">2. Select a subject</p>
          <div className="flex flex-wrap gap-2">
            {selectedClass.subjects.map(s => {
              const active = s.subject_id === selectedSubjectId;
              return (
                <button
                  key={s.subject_id}
                  onClick={() => setSelectedSubjectId(s.subject_id)}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border transition-colors duration-200 ${
                    active ? 'border-[#2472B4] bg-blue-50 text-[#2472B4]' : 'border-gray-200 text-gray-600 hover:border-[#2472B4]/50'
                  }`}
                >
                  {s.subject_name}
                  {s.result_status === 'submitted' && (
                    <span className="badge-info text-[10px] px-1.5 py-0.5">
                      Submitted
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedClass && selectedSubject && (
        <ScoreGrid
          key={`${selectedClass.class_id}:${selectedSubject.subject_id}`}
          schoolId={schoolId}
          termId={termId}
          classId={selectedClass.class_id}
          subjectId={selectedSubject.subject_id}
          isSubmitted={selectedSubject.result_status === 'submitted'}
          submitButtonLabel={`Submit ${selectedSubject.subject_name} for ${selectedClass.class_name} for approval`}
          onSubmitted={onAssignmentsChanged}
          show={show}
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeacherScoresPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<TeacherOverview | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [termName, setTermName] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<AssignmentStatus[]>([]);
  const [notifications, setNotifications] = useState<TeacherNotification[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const loadAssignments = useCallback(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: AssignmentStatus[] }>(
      `/api/schools/${schoolId}/dashboard/teacher/score-entry-status`
    )
      .then(({ data }) => setAssignments(data))
      .catch(() => show('Failed to refresh assignment status', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([
      apiFetch<{ success: boolean; data: { session: unknown; term: { id: string; name: string } | null } }>(
        `/api/schools/${schoolId}/current-context`
      ),
      apiFetch<{ success: boolean; data: TeacherOverview }>(`/api/schools/${schoolId}/dashboard/teacher/overview`),
      apiFetch<{ success: boolean; data: AssignmentStatus[] }>(
        `/api/schools/${schoolId}/dashboard/teacher/score-entry-status`
      ),
      apiFetch<{ success: boolean; data: TeacherNotification[] }>(
        `/api/schools/${schoolId}/dashboard/teacher/notifications`
      ),
    ])
      .then(([context, overviewRes, assignmentsRes, notificationsRes]) => {
        if (cancelled) return;
        setTermId(context.data.term?.id ?? null);
        setTermName(context.data.term?.name ?? null);
        setOverview(overviewRes.data);
        setAssignments(assignmentsRes.data);
        setNotifications(notificationsRes.data.filter(n => n.notification_type === 'results_returned' && n.reason));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load score entry data');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId]);

  const visibleNotifications = notifications.filter(n => !dismissedIds.has(n.id));

  if (!schoolId || loading) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <div className="skeleton h-6 w-32 mb-2" />
        <div className="skeleton h-4 w-80 mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-4">
              <div className="skeleton h-4 w-24 mb-2" />
              <div className="skeleton h-3 w-32" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  if (!termId) {
    return (
      <div className="max-w-6xl mx-auto p-8">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No active academic term has been set for this school yet.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      {toast && (
        <div className={`toast-enter fixed top-4 right-4 z-50 px-4 py-3 rounded-md shadow-lift text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Score Entry</h1>
      <p className="text-sm text-gray-500 mb-6">
        {termName ? `Active term: ${termName}.` : ''} Enter and submit scores for your assigned subjects and classes.
      </p>

      {visibleNotifications.map(n => (
        <div key={n.id} className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-amber-800 mb-1">Results returned by the principal</p>
            <p className="text-sm text-amber-700">{n.reason}</p>
          </div>
          <button
            onClick={() => setDismissedIds(prev => new Set(prev).add(n.id))}
            className="text-amber-400 hover:text-amber-600 shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}

      {overview?.teacher_mode === 'class' ? (
        <ClassModeBoard
          schoolId={schoolId}
          termId={termId}
          assignments={assignments}
          show={show}
          onAssignmentsChanged={loadAssignments}
        />
      ) : (
        <SubjectModeBoard
          schoolId={schoolId}
          termId={termId}
          assignments={assignments}
          show={show}
          onAssignmentsChanged={loadAssignments}
        />
      )}
    </div>
  );
}
