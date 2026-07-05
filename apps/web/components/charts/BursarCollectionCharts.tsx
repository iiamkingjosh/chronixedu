'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

const STATUS_COLORS: Record<'unpaid' | 'partial' | 'paid', string> = {
  unpaid: '#ef4444',
  partial: '#f59e0b',
  paid: '#22c55e',
};

function fmt(amount: number) {
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Props {
  barData: Array<{ name: string; amount: number }>;
  pieData: Array<{ name: string; value: number; status: 'unpaid' | 'partial' | 'paid' }>;
}

export default function BursarCollectionCharts({ barData, pieData }: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="card p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Amounts (₦)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={barData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `₦${Number(v).toLocaleString('en-NG')}`} width={80} />
            <Tooltip formatter={(value) => fmt(Number(value))} />
            <Bar dataKey="amount" fill="#003366" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Invoices by Status</h2>
        {pieData.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">No invoices for this term.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                {pieData.map((entry) => (
                  <Cell key={entry.status} fill={STATUS_COLORS[entry.status]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
