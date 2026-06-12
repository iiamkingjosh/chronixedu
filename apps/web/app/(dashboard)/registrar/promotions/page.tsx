'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

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

interface Decision {
  promote:  boolean;
  classId:  string;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

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

      const initial: Record<string, Decision> = {};
      for (const s of all) {
        initial[s.id] = { promote: true, classId: s.class_id ?? '' };
      }
      setDecisions(initial);
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

  function setAllPromote(promote: boolean) {
    setDecisions(prev => {
      const next: Record<string, Decision> = {};
      for (const [id, d] of Object.entries(prev)) next[id] = { ...d, promote };
      return next;
    });
  }

  const visibleStudents = classFilter
    ? students.filter(s => s.class_id === classFilter)
    : students;

  async function handleSubmit() {
    if (!schoolId || !fromSessionId || !toSessionId) return;

    const decisionList = visibleStudents.map(s => {
      const d = decisions[s.id];
      return { student_id: s.id, class_id: d?.classId ?? '', decision: d?.promote ? 'promoted' as const : 'repeat' as const };
    });

    if (decisionList.some(d => !d.class_id)) {
      show('Every student must have a class assigned before promoting', 'error');
      return;
    }

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
    return <div className="max-w-5xl mx-auto p-8"><p className="text-sm text-gray-500">Loading…</p></div>;
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

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Promotion Manager</h1>
      <p className="text-sm text-gray-500 mb-6">
        Review students at the end of a session and decide who is promoted to the next class or repeats.
      </p>

      {/* Session selectors */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <div className="grid grid-cols-3 gap-4">
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
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">
            Students ({visibleStudents.length})
          </h2>
          <div className="flex gap-2">
            <button onClick={() => setAllPromote(true)} className="text-xs font-medium text-slate-700 hover:text-slate-900">
              Mark all promoted
            </button>
            <span className="text-gray-300">|</span>
            <button onClick={() => setAllPromote(false)} className="text-xs font-medium text-slate-700 hover:text-slate-900">
              Mark all repeat
            </button>
          </div>
        </div>

        {loadingStudents ? (
          <p className="text-sm text-gray-500 px-6 py-8 text-center">Loading students…</p>
        ) : visibleStudents.length === 0 ? (
          <p className="text-sm text-gray-400 italic px-6 py-8 text-center">No students found for this session.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium">Student</th>
                <th className="text-left px-5 py-2.5 font-medium">Admission No.</th>
                <th className="text-left px-5 py-2.5 font-medium">Current Class</th>
                <th className="text-center px-5 py-2.5 font-medium">Promoted</th>
                <th className="text-left px-5 py-2.5 font-medium">New Class</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleStudents.map(s => {
                const d = decisions[s.id] ?? { promote: true, classId: s.class_id ?? '' };
                const result = results?.find(r => r.student_id === s.id);
                return (
                  <tr key={s.id}>
                    <td className="px-5 py-3 text-gray-900 font-medium">{fullName(s)}</td>
                    <td className="px-5 py-3 text-gray-600">{s.admission_no}</td>
                    <td className="px-5 py-3 text-gray-600">
                      {s.class_name ? `${s.class_name}${s.class_level ? ` (${s.class_level})` : ''}` : '—'}
                    </td>
                    <td className="px-5 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={d.promote}
                        onChange={e => setDecision(s.id, { promote: e.target.checked })}
                        className="w-4 h-4"
                      />
                    </td>
                    <td className="px-5 py-3">
                      <select
                        value={d.classId}
                        onChange={e => setDecision(s.id, { classId: e.target.value })}
                        className={inputClass}
                      >
                        <option value="">Select class…</option>
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
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={submitting || !toSessionId || visibleStudents.length === 0}
          className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Running promotion…' : `Run Bulk Promotion (${visibleStudents.length})`}
        </button>
      </div>
    </div>
  );
}
