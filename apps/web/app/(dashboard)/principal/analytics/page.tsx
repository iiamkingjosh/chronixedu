'use client';

import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  ReferenceLine,
} from 'recharts';
import { useAuth } from '@/app/providers';
import { apiFetch } from '@/lib/api';

const PASS_MARK = 40;

interface OverallPerformance {
  total_students: number;
  students_with_scores: number;
  school_average: number | null;
  pass_rate: number | null;
}

interface SubjectPerformanceRow {
  subject_id: string;
  subject_name: string;
  average: number;
  pass_rate: number;
  students_count: number;
}

interface AttendanceSummaryData {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

interface FeeCollection {
  total_expected: number;
  total_collected: number;
  total_outstanding: number;
  counts: { unpaid: number; partial: number; paid: number };
}

interface TrendItem {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

interface AnalyticsOverview {
  snapshot_date: string;
  overall_performance: OverallPerformance;
  subject_performance: SubjectPerformanceRow[];
  attendance_summary: AttendanceSummaryData;
  fee_collection: FeeCollection;
  trend: {
    school_average: TrendItem;
    attendance_percentage: TrendItem;
    fee_collected: TrendItem;
    fee_outstanding: TrendItem;
  };
}

const ATTENDANCE_COLORS: Record<'Present' | 'Absent' | 'Late' | 'Excused', string> = {
  Present: '#22c55e',
  Absent: '#ef4444',
  Late: '#f59e0b',
  Excused: '#64748b',
};

function formatCurrency(amount: number): string {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function TrendBadge({ delta, suffix = '', invert = false }: { delta: number | null; suffix?: string; invert?: boolean }) {
  if (delta === null || delta === 0) return null;
  const positive = delta > 0;
  const good = invert ? !positive : positive;
  return (
    <span className={`ml-2 text-xs font-medium ${good ? 'text-green-600' : 'text-red-600'}`}>
      {positive ? '▲' : '▼'} {Math.abs(delta).toLocaleString('en-NG', { maximumFractionDigits: 2 })}{suffix}
    </span>
  );
}

function StatCard({
  label,
  value,
  trend,
  trendSuffix = '',
  invert = false,
}: {
  label: string;
  value: string;
  trend?: TrendItem;
  trendSuffix?: string;
  invert?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 p-5 shadow-sm">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[#003366]">
        {value}
        {trend && <TrendBadge delta={trend.delta} suffix={trendSuffix} invert={invert} />}
      </p>
    </div>
  );
}

export default function PrincipalAnalyticsPage() {
  const { schoolId } = useAuth();
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!schoolId) {
      setError('No school is associated with your account.');
      setLoading(false);
      return;
    }

    apiFetch<{ success: boolean; data: AnalyticsOverview | null }>(`/api/schools/${schoolId}/analytics/overview`)
      .then((res) => setData(res.data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [schoolId]);

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-500">Loading analytics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-500">No active academic term, so analytics are not available yet.</p>
      </div>
    );
  }

  const { overall_performance, subject_performance, attendance_summary, fee_collection, trend, snapshot_date } = data;

  const subjectChartData = subject_performance.map((s) => ({ name: s.subject_name, average: s.average }));

  const attendanceChartData = (
    [
      { name: 'Present', value: attendance_summary.present },
      { name: 'Absent', value: attendance_summary.absent },
      { name: 'Late', value: attendance_summary.late },
      { name: 'Excused', value: attendance_summary.excused },
    ] as const
  ).filter((d) => d.value > 0);

  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">
          School performance, attendance, and fee collection. Last updated {snapshot_date}.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="School Average"
          value={overall_performance.school_average !== null ? `${overall_performance.school_average}%` : '—'}
          trend={trend.school_average}
          trendSuffix="%"
        />
        <StatCard
          label="Attendance Rate"
          value={`${attendance_summary.percentage}%`}
          trend={trend.attendance_percentage}
          trendSuffix="%"
        />
        <StatCard
          label="Fees Collected"
          value={formatCurrency(fee_collection.total_collected)}
          trend={trend.fee_collected}
        />
        <StatCard
          label="Fees Outstanding"
          value={formatCurrency(fee_collection.total_outstanding)}
          trend={trend.fee_outstanding}
          invert
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Subject Performance (Average %)</h2>
          {subjectChartData.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">No scores recorded for this term yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={subjectChartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} />
                <Tooltip formatter={(value) => `${value}%`} />
                <ReferenceLine y={PASS_MARK} stroke="#94a3b8" strokeDasharray="3 3" label={{ value: 'Pass mark', fontSize: 11, position: 'insideTopLeft' }} />
                <Bar dataKey="average" fill="#003366" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Attendance Breakdown</h2>
          {attendanceChartData.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">No attendance recorded for this term yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={attendanceChartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                  {attendanceChartData.map((entry) => (
                    <Cell key={entry.name} fill={ATTENDANCE_COLORS[entry.name]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Fee Collection (₦)</h2>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart
            data={[
              { name: 'Expected', amount: fee_collection.total_expected },
              { name: 'Collected', amount: fee_collection.total_collected },
              { name: 'Outstanding', amount: fee_collection.total_outstanding },
            ]}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `₦${Number(v).toLocaleString('en-NG')}`} width={80} />
            <Tooltip formatter={(value) => formatCurrency(Number(value))} />
            <Bar dataKey="amount" fill="#003366" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
