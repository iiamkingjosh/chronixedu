'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ReferenceLine,
} from 'recharts';

const PASS_MARK = 40;

const ATTENDANCE_COLORS: Record<string, string> = {
  Present: '#22c55e',
  Absent: '#ef4444',
  Late: '#f59e0b',
  Excused: '#64748b',
};

function fmt(amount: number) {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Props {
  subjectData: Array<{ name: string; average: number }>;
  attendanceData: Array<{ name: string; value: number }>;
  feeData: Array<{ name: string; amount: number }>;
}

export default function PrincipalAnalyticsCharts({ subjectData, attendanceData, feeData }: Props) {
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Subject Performance (Average %)</h2>
          {subjectData.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">No scores recorded for this term yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={subjectData}>
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
          {attendanceData.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">No attendance recorded for this term yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={attendanceData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                  {attendanceData.map((entry) => (
                    <Cell key={entry.name} fill={ATTENDANCE_COLORS[entry.name] ?? '#94a3b8'} />
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
          <BarChart data={feeData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `₦${Number(v).toLocaleString('en-NG')}`} width={80} />
            <Tooltip formatter={(value) => fmt(Number(value))} />
            <Bar dataKey="amount" fill="#003366" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
