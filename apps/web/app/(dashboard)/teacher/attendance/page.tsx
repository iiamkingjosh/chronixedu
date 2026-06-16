'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';
import { offlineDb } from '@/lib/offlineDb';
import { isNetworkError } from '@/lib/offlineSync';
import { useSyncStatus } from '@/lib/syncStatus';

// ── Types ─────────────────────────────────────────────────────────────────────

type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

interface ClassOption {
  id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface RosterEntry {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  attendance_id: string | null;
  status: AttendanceStatus | null;
}

interface AttendanceRecord {
  id: string;
  date: string;
  status: AttendanceStatus;
}

interface StudentHistory {
  records: AttendanceRecord[];
  summary: { total: number; present: number; absent: number; late: number; excused: number; percentage: number };
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

const STATUS_OPTIONS: { value: AttendanceStatus; label: string }[] = [
  { value: 'present', label: 'P' },
  { value: 'absent',  label: 'A' },
  { value: 'late',    label: 'L' },
  { value: 'excused', label: 'E' },
];

const STATUS_COLORS: Record<AttendanceStatus, string> = {
  present: 'bg-green-100 text-green-700 border-green-300',
  absent:  'bg-red-100 text-red-700 border-red-300',
  late:    'bg-amber-100 text-amber-700 border-amber-300',
  excused: 'bg-blue-100 text-blue-700 border-blue-300',
};

const STATUS_ACTIVE_COLORS: Record<AttendanceStatus, string> = {
  present: 'bg-green-600 text-white border-green-600',
  absent:  'bg-red-600 text-white border-red-600',
  late:    'bg-amber-500 text-white border-amber-500',
  excused: 'bg-blue-600 text-white border-blue-600',
};

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show: ToastFn = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

// ── Status toggle group ───────────────────────────────────────────────────────

function StatusToggleGroup({
  value,
  onChange,
}: {
  value: AttendanceStatus;
  onChange: (status: AttendanceStatus) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
      {STATUS_OPTIONS.map((opt, i) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.value[0].toUpperCase() + opt.value.slice(1)}
            className={`w-9 h-9 text-sm font-semibold transition-colors ${i > 0 ? 'border-l border-gray-200' : ''} ${
              active ? STATUS_ACTIVE_COLORS[opt.value] : 'bg-white text-gray-500 hover:bg-gray-50'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── 30-day calendar for a student ─────────────────────────────────────────────

function ThirtyDayCalendar({ schoolId, studentId, termId }: { schoolId: string; studentId: string; termId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<StudentHistory | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: StudentHistory }>(
      `/api/schools/${schoolId}/attendance/student/${studentId}?term_id=${termId}`
    )
      .then(({ data }) => { if (!cancelled) setHistory(data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load history'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId, studentId, termId]);

  const days = useMemo(() => {
    const byDate = new Map<string, AttendanceStatus>();
    for (const rec of history?.records ?? []) {
      byDate.set(rec.date.slice(0, 10), rec.status);
    }
    const result: { date: string; day: number; status: AttendanceStatus | null }[] = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      result.push({ date: iso, day: d.getDate(), status: byDate.get(iso) ?? null });
    }
    return result;
  }, [history]);

  if (loading) return <p className="text-xs text-gray-400 py-2">Loading 30-day history…</p>;
  if (error) return <p className="text-xs text-red-600 py-2">{error}</p>;

  return (
    <div className="py-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-2">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Last 30 days</p>
        {history && (
          <p className="text-xs text-gray-500">
            Term attendance: <span className="font-semibold text-gray-700">{history.summary.percentage}%</span>
            {' '}({history.summary.present} present · {history.summary.late} late · {history.summary.absent} absent · {history.summary.excused} excused)
          </p>
        )}
      </div>
      <div className="grid grid-cols-10 sm:grid-cols-15 gap-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
        {days.map(d => (
          <div
            key={d.date}
            title={`${d.date}${d.status ? ` — ${d.status}` : ' — no record'}`}
            className={`flex items-center justify-center h-7 rounded text-[11px] font-medium border ${
              d.status ? STATUS_COLORS[d.status] : 'bg-gray-50 text-gray-300 border-gray-100'
            }`}
          >
            {d.day}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-gray-500">
        {STATUS_OPTIONS.map(opt => (
          <span key={opt.value} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-3 h-3 rounded border ${STATUS_COLORS[opt.value]}`} />
            {opt.value[0].toUpperCase() + opt.value.slice(1)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded border bg-gray-50 border-gray-100" />
          No record
        </span>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeacherAttendancePage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();
  const { refresh: refreshSyncStatus } = useSyncStatus();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [termId, setTermId] = useState<string | null>(null);
  const [termName, setTermName] = useState<string | null>(null);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  const [date, setDate] = useState(todayDate());

  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState('');
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [expandedStudentId, setExpandedStudentId] = useState<string | null>(null);

  // Initial load: term context + class list
  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([
      apiFetch<{ success: boolean; data: { session: unknown; term: { id: string; name: string } | null } }>(
        `/api/schools/${schoolId}/current-context`
      ),
      apiFetch<{ success: boolean; data: ClassOption[] }>(`/api/schools/${schoolId}/classes`),
    ])
      .then(([context, classesRes]) => {
        if (cancelled) return;
        setTermId(context.data.term?.id ?? null);
        setTermName(context.data.term?.name ?? null);
        setClasses(classesRes.data);
        if (classesRes.data.length > 0) setClassId(classesRes.data[0].id);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load attendance setup'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId]);

  const loadRoster = useCallback(() => {
    if (!schoolId || !classId || !date) return;
    setRosterLoading(true);
    setRosterError('');
    setExpandedStudentId(null);
    const params = new URLSearchParams({ class_id: classId, date });
    apiFetch<{ success: boolean; data: { roster: RosterEntry[] } }>(
      `/api/schools/${schoolId}/attendance/class?${params.toString()}`
    )
      .then(({ data }) => {
        setRoster(data.roster);
        const initial: Record<string, AttendanceStatus> = {};
        for (const entry of data.roster) {
          initial[entry.student_id] = entry.status ?? 'present';
        }
        setStatuses(initial);
      })
      .catch((err: unknown) => setRosterError(err instanceof Error ? err.message : 'Failed to load class roster'))
      .finally(() => setRosterLoading(false));
  }, [schoolId, classId, date]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  function setStatus(studentId: string, status: AttendanceStatus) {
    setStatuses(prev => ({ ...prev, [studentId]: status }));
  }

  function markAllPresent() {
    setStatuses(() => {
      const next: Record<string, AttendanceStatus> = {};
      for (const entry of roster) next[entry.student_id] = 'present';
      return next;
    });
  }

  const alreadyMarked = roster.some(entry => entry.attendance_id !== null);

  async function queueOffline(classId: string, entries: { student_id: string; status: AttendanceStatus }[]) {
    await offlineDb.offline_attendance_queue.add({
      school_id: schoolId!,
      class_id: classId,
      date,
      entries,
      queued_at: new Date().toISOString(),
    });
    refreshSyncStatus();
    show('You are offline. Attendance saved locally and will sync when you reconnect.');
  }

  async function handleSave() {
    if (!schoolId || !classId) return;
    setSaving(true);
    try {
      const entries = roster.map(entry => ({ student_id: entry.student_id, status: statuses[entry.student_id] ?? 'present' }));
      if (!navigator.onLine) {
        await queueOffline(classId, entries);
        return;
      }
      await apiFetch(`/api/schools/${schoolId}/attendance/mark`, {
        method: 'POST',
        body: JSON.stringify({ class_id: classId, date, entries }),
      });
      show(alreadyMarked ? 'Attendance updated' : 'Attendance saved');
      loadRoster();
    } catch (err: unknown) {
      if (isNetworkError(err)) {
        const entries = roster.map(entry => ({ student_id: entry.student_id, status: statuses[entry.student_id] ?? 'present' }));
        await queueOffline(classId, entries);
        return;
      }
      show(err instanceof Error ? err.message : 'Failed to save attendance', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!schoolId || loading) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <p className="text-sm text-gray-500">Loading attendance…</p>
      </div>
    );
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

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Attendance</h1>
      <p className="text-sm text-gray-500 mb-6">
        {termName ? `Active term: ${termName}.` : ''} Mark daily attendance and review attendance history per student.
      </p>

      <div className="flex flex-wrap items-end gap-4 mb-6 bg-white border border-gray-200 rounded-xl p-5">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Class</label>
          <select
            value={classId ?? ''}
            onChange={e => setClassId(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 min-w-[10rem]"
          >
            {classes.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={markAllPresent}
          disabled={rosterLoading || roster.length === 0}
          className="px-4 py-2 border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Mark all present
        </button>
        <div className="ml-auto">
          <button
            onClick={handleSave}
            disabled={saving || rosterLoading || roster.length === 0}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : alreadyMarked ? 'Save corrections' : 'Save attendance'}
          </button>
        </div>
      </div>

      {alreadyMarked && !rosterLoading && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-700">
          Attendance has already been recorded for this class on {date}. Existing values are pre-loaded — adjust and save to correct.
        </div>
      )}

      {rosterError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700">{rosterError}</div>
      )}

      {rosterLoading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading class roster…</p>
      ) : roster.length === 0 ? (
        <p className="text-sm text-gray-500 py-10 text-center">No students are enrolled in this class.</p>
      ) : (
        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 bg-white">
          {roster.map(entry => {
            const expanded = expandedStudentId === entry.student_id;
            return (
              <div key={entry.student_id}>
                <div className="flex items-center gap-4 px-5 py-3.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{entry.first_name} {entry.last_name}</p>
                    <p className="text-xs text-gray-500">{entry.admission_no}</p>
                  </div>
                  <StatusToggleGroup
                    value={statuses[entry.student_id] ?? 'present'}
                    onChange={status => setStatus(entry.student_id, status)}
                  />
                  <button
                    onClick={() => setExpandedStudentId(expanded ? null : entry.student_id)}
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                  >
                    {expanded ? 'Hide history' : '30-day history'}
                  </button>
                </div>
                {expanded && termId && (
                  <div className="px-5 pb-2 -mt-1 border-t border-gray-100">
                    <ThirtyDayCalendar schoolId={schoolId} studentId={entry.student_id} termId={termId} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
