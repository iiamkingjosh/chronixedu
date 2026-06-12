'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassOption {
  id: string;
  name: string;
  level: string;
  stream: string | null;
}

interface ClassTermSummaryRow {
  class_id: string;
  class_name: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  percentage: number;
}

interface AlertRow {
  id: string;
  student_id: string;
  alert_type: string;
  triggered_at: string;
  is_resolved: boolean;
  first_name: string;
  last_name: string;
  admission_no: string;
}

interface MonthlySummaryRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  percentage: number;
}

type ToastFn = (message: string, type?: 'success' | 'error') => void;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function percentageBarColor(pct: number): string {
  if (pct >= 85) return 'bg-green-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-red-500';
}

function downloadCsv(filename: string, rows: MonthlySummaryRow[]): void {
  const header = ['Admission No.', 'Name', 'Present', 'Absent', 'Late', 'Excused', 'Total', 'Percentage'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.admission_no,
      `"${row.first_name} ${row.last_name}"`,
      row.present,
      row.absent,
      row.late,
      row.excused,
      row.total,
      row.percentage,
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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

// ── Class attendance summary ──────────────────────────────────────────────────

function ClassAttendanceSummary({ rows }: { rows: ClassTermSummaryRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-500 py-6 text-center">No classes found for this school.</p>;
  }
  return (
    <div className="space-y-3">
      {rows.map(row => (
        <div key={row.class_id} className="flex items-center gap-4">
          <p className="w-28 shrink-0 text-sm font-medium text-gray-900 truncate">{row.class_name}</p>
          <div className="flex-1 h-2.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full ${percentageBarColor(row.percentage)}`}
              style={{ width: `${Math.min(row.percentage, 100)}%` }}
            />
          </div>
          <p className="w-16 shrink-0 text-sm font-semibold text-gray-900 text-right">{row.percentage}%</p>
          <p className="w-44 shrink-0 text-xs text-gray-400 text-right">
            {row.total === 0 ? 'No records yet' : `${row.present + row.late} / ${row.total} days present`}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Chronic absenteeism list ──────────────────────────────────────────────────

function ChronicAbsenteeismList({ alerts }: { alerts: AlertRow[] }) {
  if (alerts.length === 0) {
    return <p className="text-sm text-gray-500 py-6 text-center">No active low-attendance alerts. 🎉</p>;
  }
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-xl">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Student</th>
            <th className="px-4 py-3 text-left font-medium">Admission No.</th>
            <th className="px-4 py-3 text-left font-medium">Alert Type</th>
            <th className="px-4 py-3 text-left font-medium">Triggered</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {alerts.map(alert => (
            <tr key={alert.id}>
              <td className="px-4 py-2.5 whitespace-nowrap text-gray-900">{alert.first_name} {alert.last_name}</td>
              <td className="px-4 py-2.5 whitespace-nowrap text-gray-500">{alert.admission_no}</td>
              <td className="px-4 py-2.5 whitespace-nowrap">
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">
                  {alert.alert_type === 'low_attendance' ? 'Low attendance' : alert.alert_type}
                </span>
              </td>
              <td className="px-4 py-2.5 whitespace-nowrap text-gray-500">
                {new Date(alert.triggered_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── CSV export panel ──────────────────────────────────────────────────────────

function MonthlyExportPanel({ schoolId, classes, show }: { schoolId: string; classes: ClassOption[]; show: ToastFn }) {
  const now = new Date();
  const [classId, setClassId] = useState<string | null>(classes[0]?.id ?? null);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!classId && classes.length > 0) setClassId(classes[0].id);
  }, [classes, classId]);

  const years = useMemo(() => {
    const current = now.getFullYear();
    return [current - 1, current, current + 1];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleExport() {
    if (!classId) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({ class_id: classId, month: String(month), year: String(year) });
      const { data } = await apiFetch<{ success: boolean; data: { class: { name: string }; students: MonthlySummaryRow[] } }>(
        `/api/schools/${schoolId}/attendance/monthly-summary?${params.toString()}`
      );
      if (data.students.length === 0) {
        show('No attendance records found for this selection', 'error');
        return;
      }
      const filename = `attendance-${data.class.name.replace(/\s+/g, '_')}-${year}-${String(month).padStart(2, '0')}.csv`;
      downloadCsv(filename, data.students);
      show('Monthly summary exported');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Failed to export monthly summary', 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
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
      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Month</label>
        <select
          value={month}
          onChange={e => setMonth(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>{name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-gray-400 mb-1.5">Year</label>
        <select
          value={year}
          onChange={e => setYear(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
          {years.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
      <button
        onClick={handleExport}
        disabled={exporting || !classId}
        className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
      >
        {exporting ? 'Exporting…' : 'Export CSV'}
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PrincipalAttendancePage() {
  const { schoolId } = useAuth();
  const { toast, show } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [termName, setTermName] = useState<string | null>(null);
  const [classSummary, setClassSummary] = useState<ClassTermSummaryRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [noActiveTerm, setNoActiveTerm] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setNoActiveTerm(false);

    apiFetch<{ success: boolean; data: { session: unknown; term: { id: string; name: string } | null } }>(
      `/api/schools/${schoolId}/current-context`
    )
      .then(context => {
        if (cancelled) return;
        const term = context.data.term;
        setTermName(term?.name ?? null);
        if (!term) {
          setNoActiveTerm(true);
          return Promise.resolve();
        }

        return Promise.all([
          apiFetch<{ success: boolean; data: { classes: ClassTermSummaryRow[] } }>(
            `/api/schools/${schoolId}/attendance/class-summary?term_id=${term.id}`
          ),
          apiFetch<{ success: boolean; data: AlertRow[] }>(`/api/schools/${schoolId}/attendance/alerts`),
          apiFetch<{ success: boolean; data: ClassOption[] }>(`/api/schools/${schoolId}/classes`),
        ]).then(([summaryRes, alertsRes, classesRes]) => {
          if (cancelled) return;
          setClassSummary(summaryRes.data.classes);
          setAlerts(alertsRes.data);
          setClasses(classesRes.data);
        });
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load attendance overview'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [schoolId]);

  if (!schoolId || loading) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <p className="text-sm text-gray-500">Loading attendance overview…</p>
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

      <h1 className="text-xl font-semibold text-gray-900 mb-1">Attendance Overview</h1>
      <p className="text-sm text-gray-500 mb-6">
        {termName ? `Active term: ${termName}.` : ''} School-wide attendance, chronic absenteeism alerts, and monthly exports.
      </p>

      {noActiveTerm ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
          No active academic term has been set for this school yet.
        </div>
      ) : (
        <div className="space-y-6">
          <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Attendance % per class — this term</h2>
            <p className="text-xs text-gray-400 mb-4">Share of recorded school days marked present or late.</p>
            <ClassAttendanceSummary rows={classSummary} />
          </section>

          <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Chronic absenteeism</h2>
            <p className="text-xs text-gray-400 mb-4">Students with unresolved low-attendance alerts (3+ absences within a 7-day window).</p>
            <ChronicAbsenteeismList alerts={alerts} />
          </section>

          <section className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Export monthly summary</h2>
            <p className="text-xs text-gray-400 mb-4">Download a CSV of per-student attendance percentages for a class and month.</p>
            <MonthlyExportPanel schoolId={schoolId} classes={classes} show={show} />
          </section>
        </div>
      )}
    </div>
  );
}
