'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { useParentContext } from '@/lib/parentContext';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

interface AttendanceRecord {
  id: string;
  date: string;
  status: AttendanceStatus;
}

interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

interface AttendanceData {
  records: AttendanceRecord[];
  summary: AttendanceSummary;
}

interface TermContext {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}

const STATUS_COLORS: Record<AttendanceStatus, string> = {
  present: 'bg-green-100 text-green-700 border-green-300',
  absent:  'bg-red-100 text-red-700 border-red-300',
  late:    'bg-amber-100 text-amber-700 border-amber-300',
  excused: 'bg-blue-100 text-blue-700 border-blue-300',
};

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Month calendar ────────────────────────────────────────────────────────────

function MonthCalendar({
  year,
  month,
  byDate,
  rangeStart,
  rangeEnd,
}: {
  year: number;
  month: number; // 0-indexed
  byDate: Map<string, AttendanceStatus>;
  rangeStart: Date;
  rangeEnd: Date;
}) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = new Date(year, month, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const cells: { date: string | null; day: number | null; status: AttendanceStatus | null; inRange: boolean }[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ date: null, day: null, status: null, inRange: false });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const inRange = d >= rangeStart && d <= rangeEnd;
    cells.push({ date: iso, day, status: byDate.get(iso) ?? null, inRange });
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
      <p className="text-sm font-semibold text-gray-900 mb-3">{monthName}</p>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map(w => (
          <div key={w} className="text-center text-[10px] font-medium uppercase tracking-wide text-gray-400">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) =>
          c.date === null ? (
            <div key={`empty-${i}`} />
          ) : (
            <div
              key={c.date}
              title={`${c.date}${c.status ? ` — ${STATUS_LABELS[c.status]}` : c.inRange ? ' — no record' : ''}`}
              className={`flex items-center justify-center h-8 rounded text-xs font-medium border ${
                !c.inRange
                  ? 'bg-white text-gray-200 border-transparent'
                  : c.status
                    ? STATUS_COLORS[c.status]
                    : 'bg-gray-50 text-gray-300 border-gray-100'
              }`}
            >
              {c.day}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ParentAttendancePage() {
  const { schoolId } = useAuth();
  const { selectedChild, loading: childrenLoading, error: childrenError, children: linkedChildren } = useParentContext();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [term, setTerm] = useState<TermContext | null>(null);
  const [attendance, setAttendance] = useState<AttendanceData | null>(null);

  useEffect(() => {
    if (!schoolId || !selectedChild) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    apiFetch<{ success: boolean; data: { term: TermContext | null } }>(`/api/schools/${schoolId}/current-context`)
      .then(({ data }) => {
        if (cancelled) return;
        if (!data.term) {
          setError('No active term has been set up yet.');
          return null;
        }
        setTerm(data.term);
        return apiFetch<{ success: boolean; data: AttendanceData }>(
          `/api/schools/${schoolId}/parent/students/${selectedChild.student_id}/attendance?term_id=${data.term.id}`
        );
      })
      .then(res => {
        if (cancelled || !res) return;
        setAttendance(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load attendance');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [schoolId, selectedChild]);

  const byDate = useMemo(() => {
    const map = new Map<string, AttendanceStatus>();
    for (const rec of attendance?.records ?? []) {
      map.set(rec.date.slice(0, 10), rec.status);
    }
    return map;
  }, [attendance]);

  const months = useMemo(() => {
    if (!term) return [];
    const start = new Date(term.start_date);
    const end = new Date(term.end_date);
    const result: { year: number; month: number }[] = [];
    let y = start.getFullYear();
    let m = start.getMonth();
    while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
      result.push({ year: y, month: m });
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return result;
  }, [term]);

  if (childrenLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (childrenError) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{childrenError}</div>
      </div>
    );
  }

  if (linkedChildren.length === 0 || !selectedChild) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No students are linked to your account yet. Please contact your school&apos;s administration.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Attendance</h1>
        <p className="text-sm text-gray-500">
          {selectedChild.first_name} {selectedChild.last_name}
          {term ? ` · ${term.name}` : ''}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading attendance…</p>
      ) : attendance && term && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-[#2472B4]">{attendance.summary.percentage}%</p>
                <p className="text-xs text-gray-500 mt-1">Term attendance rate</p>
              </div>
              <div className="text-right text-xs text-gray-500 space-y-0.5">
                <p>Present: <span className="font-medium text-gray-700">{attendance.summary.present}</span></p>
                <p>Absent: <span className="font-medium text-gray-700">{attendance.summary.absent}</span></p>
                <p>Late: <span className="font-medium text-gray-700">{attendance.summary.late}</span></p>
                <p>Excused: <span className="font-medium text-gray-700">{attendance.summary.excused}</span></p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {months.map(({ year, month }) => (
              <MonthCalendar
                key={`${year}-${month}`}
                year={year}
                month={month}
                byDate={byDate}
                rangeStart={new Date(term.start_date)}
                rangeEnd={new Date(term.end_date)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
            {(Object.keys(STATUS_LABELS) as AttendanceStatus[]).map(status => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span className={`inline-block w-3 h-3 rounded border ${STATUS_COLORS[status]}`} />
                {STATUS_LABELS[status]}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded border bg-gray-50 border-gray-100" />
              No record
            </span>
          </div>
        </>
      )}
    </div>
  );
}
