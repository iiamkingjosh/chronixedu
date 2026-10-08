'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { buildPromotionPayload, type PromotionRowState, type PromotionChoice } from '@/lib/promotionDecisions';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  school_id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
}

interface ClassRow {
  id: string;
  school_id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface StudentListRow {
  id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  email: string;
  class_id: string | null;
  class_name: string | null;
  class_level: string | null;
}

interface PromotionResult {
  student_id: string;
  status: 'enrolled' | 'skipped';
  reason?: string;
}

type Decision = PromotionRowState;

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

const inputClass = 'input-field';

function fullName(s: StudentListRow): string {
  return `${s.first_name} ${s.last_name}`;
}

function classLabel(c: ClassRow): string {
  return `${c.name} (${c.level}${c.stream ? ` — ${c.stream}` : ''})`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [fromSessionId, setFromSessionId] = useState('');
  const [toSessionId, setToSessionId] = useState('');
  const [classFilter, setClassFilter] = useState('');

  const [students, setStudents] = useState<StudentListRow[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<PromotionResult[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  // Load sessions + classes
  useEffect(() => {
    if (!schoolId) return;
    apiFetch<{ success: boolean; data: SessionRow[] }>(`/api/schools/${schoolId}/sessions`)
      .then(({ data }) => {
        setSessions(data);
        const current = data.find(s => s.is_current);
        if (current) setFromSessionId(current.id);
      })
      .catch(() => show('Failed to load sessions', 'error'));

    apiFetch<{ success: boolean; data: ClassRow[] }>(`/api/schools/${schoolId}/classes`)
      .then(({ data }) => setClasses(data))
      .catch(() => show('Failed to load classes', 'error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  // Load all students enrolled in the "from" session
  const loadStudents = useCallback(async () => {
    if (!schoolId || !fromSessionId) return;
    setLoadingStudents(true);
    setResults(null);
    try {
      const all: StudentListRow[] = [];
      let page = 1;
      let pages = 1;
      do {
        const res = await apiFetch<{ success: boolean; data: StudentListRow[]; meta: { pages: number } }>(
          `/api/schools/${schoolId}/students?session_id=${fromSessionId}&page=${page}&limit=100`
        );
        all.push(...res.data);
        pages = res.meta.pages;
        page++;
      } while (page <= pages);

      setStudents(all);

      // Nobody is decided until someone decides (doctrine 8).
      const initial: Record<string, Decision> = {};
      for (const s of all) {
        initial[s.id] = { decision: null, classId: '' };
      }
      setDecisions(initial);
      setProblems([]);
    } catch {
      show('Failed to load students for this session', 'error');
    } finally {
      setLoadingStudents(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, fromSessionId]);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  function setDecision(studentId: string, patch: Partial<Decision>) {
    setDecisions(prev => ({ ...prev, [studentId]: { ...prev[studentId], ...patch } }));
  }

  function setAll(decision: PromotionChoice) {
    setDecisions(prev => {
      const next: Record<string, Decision> = {};
      for (const [id, d] of Object.entries(prev)) next[id] = { ...d, decision };
      return next;
    });
  }

  const visibleStudents = classFilter
    ? students.filter(s => s.class_id === classFilter)
    : students;

  async function handleSubmit() {
    if (!schoolId || !fromSessionId || !toSessionId) return;

    const payload = buildPromotionPayload(visibleStudents, decisions);
    setProblems(payload.problems);
    if (payload.problems.length > 0) return;
    const decisionList = payload.decisions;

    setSubmitting(true);
    setResults(null);
    try {
      const res = await apiFetch<{ success: boolean; data: { results: PromotionResult[] } }>(
        `/api/schools/${schoolId}/students/promote-bulk`,
        {
          method: 'POST',
          body: JSON.stringify({
            from_session_id: fromSessionId,
            to_session_id:   toSessionId,
            decisions:       decisionList,
          }),
        }
      );
      setResults(res.data.results);
      const enrolled = res.data.results.filter(r => r.status === 'enrolled').length;
      const skipped  = res.data.results.filter(r => r.status === 'skipped').length;
      show(`Promotion complete: ${enrolled} enrolled, ${skipped} skipped`);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to run bulk promotion', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!schoolId) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <div className="skeleton h-6 w-48 mb-2" />
        <div className="skeleton h-4 w-96 mb-6" />
        <div className="card p-6 mb-6 space-y-3">
          <div className="skeleton h-4 w-32" />
          <div className="skeleton h-9 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      {toast && (
        <div className={`toast-enter fixed top-4 right-4 z-50 px-4 py-3 rounded-md shadow-lift text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="font-heading text-xl font-semibold text-gray-900 mb-1">Promotion Manager</h1>
      <p className="text-sm text-gray-500 mb-6">
        Review students at the end of a session and decide who is promoted to the next class or repeats.
      </p>

      {/* Session selectors */}
      <div className="card p-6 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">From session (ending)</label>
            <select value={fromSessionId} onChange={e => setFromSessionId(e.target.value)} className={inputClass}>
              <option value="">Select session…</option>
              {sessions.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.is_current ? ' (current)' : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To session (new)</label>
            <select value={toSessionId} onChange={e => setToSessionId(e.target.value)} className={inputClass}>
              <option value="">Select session…</option>
              {sessions.filter(s => s.id !== fromSessionId).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Filter by current class</label>
            <select value={classFilter} onChange={e => setClassFilter(e.target.value)} className={inputClass}>
              <option value="">All classes</option>
              {classes.map(c => (
                <option key={c.id} value={c.id}>{classLabel(c)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Students table */}
      <div className="card overflow-hidden mb-6">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="font-heading text-sm font-semibold text-gray-900">
            Students ({visibleStudents.length})
          </h2>
          <div className="flex gap-2">
            <button onClick={() => setAll('promoted')} className="text-xs font-medium text-[#2472B4] hover:underline transition-colors duration-200">
              Mark all promoted
            </button>
            <span className="text-gray-300">|</span>
            <button onClick={() => setAll('repeat')} className="text-xs font-medium text-[#2472B4] hover:underline transition-colors duration-200">
              Mark all repeating
            </button>
          </div>
        </div>

        {loadingStudents ? (
          <div className="px-6 py-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6">
                <div className="skeleton h-4 w-32" />
                <div className="skeleton h-4 w-24" />
                <div className="skeleton h-4 w-28" />
                <div className="skeleton h-4 w-40 ml-auto" />
              </div>
            ))}
          </div>
        ) : visibleStudents.length === 0 ? (
          <p className="text-sm text-gray-400 italic px-6 py-8 text-center">No students found for this session.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium">Student</th>
                <th className="text-left px-5 py-2.5 font-medium">Admission No.</th>
                <th className="text-left px-5 py-2.5 font-medium">Current Class</th>
                <th className="text-left px-5 py-2.5 font-medium">Decision</th>
                <th className="text-left px-5 py-2.5 font-medium">Class next session</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleStudents.map(s => {
                const d = decisions[s.id] ?? { decision: null, classId: '' };
                const result = results?.find(r => r.student_id === s.id);
                return (
                  <tr key={s.id} className="table-row-hover">
                    <td className="px-5 py-3 text-gray-900 font-medium">{fullName(s)}</td>
                    <td className="px-5 py-3 text-gray-600">{s.admission_no}</td>
                    <td className="px-5 py-3 text-gray-600">
                      {s.class_name ? `${s.class_name}${s.class_level ? ` (${s.class_level})` : ''}` : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <select
                        value={d.decision ?? ''}
                        onChange={e => setDecision(s.id, { decision: (e.target.value || null) as PromotionChoice })}
                        className={inputClass}
                        aria-label={`Decision for ${fullName(s)}`}
                      >
                        <option value="">Not decided</option>
                        <option value="promoted">Promoted</option>
                        <option value="repeat">Repeats</option>
                      </select>
                    </td>
                    <td className="px-5 py-3">
                      <select
                        value={d.classId}
                        onChange={e => setDecision(s.id, { classId: e.target.value })}
                        className={inputClass}
                        aria-label={`Class next session for ${fullName(s)}`}
                      >
                        <option value="">{d.decision === 'repeat' ? 'Same class' : 'Select class…'}</option>
                        {classes.map(c => (
                          <option key={c.id} value={c.id}>{classLabel(c)}</option>
                        ))}
                      </select>
                      {result && (
                        <p className={`mt-1 text-xs ${result.status === 'enrolled' ? 'text-green-600' : 'text-amber-600'}`}>
                          {result.status === 'enrolled' ? 'Enrolled in new session' : `Skipped${result.reason ? `: ${result.reason}` : ''}`}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {problems.length > 0 && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <ul className="list-disc list-inside text-sm text-red-700 space-y-0.5">
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={submitting || !toSessionId || visibleStudents.length === 0}
          className="btn-primary"
        >
          {submitting ? 'Running promotion…' : `Run Bulk Promotion (${visibleStudents.length})`}
        </button>
      </div>
    </div>
  );
}
