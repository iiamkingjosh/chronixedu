'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'minor' | 'serious' | 'suspension';

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
}

interface BehaviourRecord {
  id: string;
  incident_type: string;
  description: string | null;
  sanction: string | null;
  severity: Severity;
  date: string;
  class_name: string;
  term_name: string;
  reported_by_name: string;
  parent_notified_at: string | null;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: 'minor', label: 'Minor' },
  { value: 'serious', label: 'Serious' },
  { value: 'suspension', label: 'Suspension' },
];

const SEVERITY_BADGE: Record<Severity, string> = {
  minor: 'bg-amber-50 text-amber-700 border-amber-200',
  serious: 'bg-orange-50 text-orange-700 border-orange-200',
  suspension: 'bg-red-50 text-red-700 border-red-200',
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

// ── Student history ───────────────────────────────────────────────────────────

function StudentHistory({ schoolId, studentId }: { schoolId: string; studentId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [records, setRecords] = useState<BehaviourRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: BehaviourRecord[] }>(`/api/schools/${schoolId}/behaviour/students/${studentId}`)
      .then(({ data }) => { if (!cancelled) setRecords(data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load history'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId, studentId]);

  if (loading) return <p className="text-xs text-gray-400 py-2">Loading history…</p>;
  if (error) return <p className="text-xs text-red-600 py-2">{error}</p>;
  if (records.length === 0) return <p className="text-xs text-gray-400 py-2">No incidents recorded for this student.</p>;

  return (
    <div className="py-2 space-y-2">
      {records.map(r => (
        <div key={r.id} className="border border-gray-100 rounded-lg p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-900">{r.incident_type}</p>
              <p className="text-xs text-gray-500">{new Date(r.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} · {r.term_name} · Reported by {r.reported_by_name}</p>
            </div>
            <span className={`shrink-0 text-[10px] font-medium uppercase tracking-wide px-2 py-1 rounded-md border ${SEVERITY_BADGE[r.severity]}`}>
              {r.severity}
            </span>
          </div>
          {r.description && <p className="text-sm text-gray-700 mt-1.5">{r.description}</p>}
          {r.sanction && <p className="text-xs text-gray-500 mt-1">Sanction: {r.sanction}</p>}
          <p className="text-[11px] text-gray-400 mt-1.5">
            {r.parent_notified_at
              ? `Parent notified ${new Date(r.parent_notified_at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
              : 'Parent notification queued'}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TeacherBehaviourPage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState<string | null>(null);

  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState('');
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [studentId, setStudentId] = useState<string | null>(null);

  const [incidentType, setIncidentType] = useState('');
  const [description, setDescription] = useState('');
  const [sanction, setSanction] = useState('');
  const [severity, setSeverity] = useState<Severity>('minor');
  const [date, setDate] = useState(todayDate());
  const [submitting, setSubmitting] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<{ success: boolean; data: ClassOption[] }>(`/api/schools/${schoolId}/classes`)
      .then(({ data }) => {
        if (cancelled) return;
        setClasses(data);
        if (data.length > 0) setClassId(data[0].id);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load classes'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId]);

  const loadRoster = useCallback(() => {
    if (!schoolId || !classId) return;
    setRosterLoading(true);
    setRosterError('');
    setStudentId(null);
    const params = new URLSearchParams({ class_id: classId, date: todayDate() });
    apiFetch<{ success: boolean; data: { roster: RosterEntry[] } }>(`/api/schools/${schoolId}/attendance/class?${params.toString()}`)
      .then(({ data }) => {
        setRoster(data.roster);
        if (data.roster.length > 0) setStudentId(data.roster[0].student_id);
      })
      .catch((err: unknown) => setRosterError(err instanceof Error ? err.message : 'Failed to load class roster'))
      .finally(() => setRosterLoading(false));
  }, [schoolId, classId]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !classId || !studentId || !incidentType.trim()) return;

    setSubmitting(true);
    try {
      await apiFetch(`/api/schools/${schoolId}/behaviour`, {
        method: 'POST',
        body: JSON.stringify({
          student_id: studentId,
          class_id: classId,
          incident_type: incidentType.trim(),
          description: description.trim() || null,
          sanction: sanction.trim() || null,
          severity,
          date,
        }),
      });
      show(severity === 'suspension' ? 'Incident logged. Parent notified immediately.' : 'Incident logged. Parent notification queued.');
      setIncidentType('');
      setDescription('');
      setSanction('');
      setSeverity('minor');
      setDate(todayDate());
      setHistoryKey(k => k + 1);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to log incident', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!schoolId || loading) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Behaviour</h1>
      <p className="text-sm text-gray-500 mb-6">Log a behaviour incident for a student.</p>

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Class</label>
            <select
              value={classId ?? ''}
              onChange={e => setClassId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {classes.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Student</label>
            {rosterLoading ? (
              <p className="text-sm text-gray-400 py-2">Loading roster…</p>
            ) : rosterError ? (
              <p className="text-xs text-red-600 py-2">{rosterError}</p>
            ) : roster.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">No students in this class.</p>
            ) : (
              <select
                value={studentId ?? ''}
                onChange={e => setStudentId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                {roster.map(r => (
                  <option key={r.student_id} value={r.student_id}>{r.first_name} {r.last_name} ({r.admission_no})</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Incident type</label>
          <input
            type="text"
            value={incidentType}
            onChange={e => setIncidentType(e.target.value)}
            placeholder="e.g. Disruptive behaviour in class"
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Sanction</label>
          <input
            type="text"
            value={sanction}
            onChange={e => setSanction(e.target.value)}
            placeholder="e.g. Detention, written warning"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Severity</label>
            <select
              value={severity}
              onChange={e => setSeverity(e.target.value as Severity)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {SEVERITY_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>
        </div>

        {severity === 'suspension' && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            This will notify the parent immediately, not via the standard queue.
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !studentId || !incidentType.trim()}
          className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? 'Logging…' : 'Log incident'}
        </button>
      </form>

      {studentId && (
        <div className="mt-6 bg-white border border-gray-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">History</h2>
          <p className="text-xs text-gray-500 mb-2">Incidents recorded for the selected student.</p>
          <StudentHistory key={historyKey} schoolId={schoolId} studentId={studentId} />
        </div>
      )}
    </div>
  );
}
